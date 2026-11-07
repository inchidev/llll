import { fileStorage } from '../../shared/file-storage'
import { isCloudHosted } from '../../shared/server-runtime'
import type { L4Env } from '../../workers/env'

/**
 * What L4 Cloud asks of a hosted Server, under `/.llll/cloud/`, with the Server's own `CLOUD_SECRET` as a bearer
 * token: run the scheduled work (user Workers may get no Cron Trigger of their own), and empty the files bucket before
 * the control plane deletes it. Only a Server with `LLLL_RUNTIME=cloud` and a secret answers; everything else is 404,
 * so that the paths say nothing on any other Server.
 */
export const CLOUD_RELAY_PREFIX = '/.llll/cloud/'

// Compared as digests of equal length, byte by byte without an early exit, so that timing says nothing about the secret.
async function sameSecret(given: string, expected: string) {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(a), right = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

async function authorized(request: Request, env: L4Env) {
  const secret = env.CLOUD_SECRET?.trim()
  if (!isCloudHosted(env) || !secret || secret.length < 16) return false
  const header = request.headers.get('authorization') || ''
  const given = /^Bearer\s+(\S+)$/iu.exec(header)?.[1]
  return Boolean(given) && sameSecret(given!, secret)
}

/** Deletes every object in the files bucket, so that the bucket can be deleted. Returns how many went. */
export async function purgeServerFiles(env: L4Env) {
  if (!env.FILES) return 0
  const store = fileStorage(env)
  let deleted = 0
  let cursor: string | undefined
  do {
    const page = await store.list({ limit: 500, cursor })
    const keys = page.objects.map(object => object.key)
    if (keys.length) { await store.delete(keys); deleted += keys.length }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return deleted
}

export async function cloudRelay(request: Request, env: L4Env, pathname: string, scheduled: (env: L4Env) => Promise<void>): Promise<Response | null> {
  if (!pathname.startsWith(CLOUD_RELAY_PREFIX)) return null
  if (request.method !== 'POST' || !(await authorized(request, env))) return new Response('Not found', { status: 404 })
  const action = pathname.slice(CLOUD_RELAY_PREFIX.length)
  if (action === 'scheduled') {
    await scheduled(env)
    return Response.json({ ok: true })
  }
  if (action === 'purge-files') return Response.json({ ok: true, deleted: await purgeServerFiles(env) })
  return new Response('Not found', { status: 404 })
}
