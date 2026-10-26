import { toWebRequest } from 'h3'
import { readLimitedStream } from '../../../workers/inbound-email-signature'
import { z } from 'zod'
import { cf, fail } from '../../utils/cf'
import { dockerCapabilities } from '../../../shared/software-factory'
import { factoryHash } from '../../utils/factory-authority'
import { getServerId } from '../../../shared/server-id'
import { nowIso } from '../../../shared/ids'

/** Only the trusted VPS host can sign this narrowly scoped, replay-safe pairing. */
export default defineEventHandler(async event => {
  const { env } = cf(event)
  if (env.LLLL_RUNTIME !== 'celld' || !env.AUTH_SECRET || !env.PUBLIC_ORIGIN) fail(403, 'local_compute_denied', 'Local pairing is available only on the VPS host')
  const body = await readLimitedStream(toWebRequest(event).body, 4096)
  if (!body.ok) fail(413, 'local_compute_invalid', 'Local pairing request is too large')
  const raw = new TextDecoder().decode(body.bytes)
  if (!raw) fail(400, 'local_compute_invalid', 'Invalid local pairing')
  const signature = getHeader(event, 'x-l4-local-signature') ?? ''
  if (!/^[a-f0-9]{64}$/u.test(signature)) fail(403, 'local_compute_denied', 'Invalid local signature')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../gu)!, byte => parseInt(byte, 16)), new TextEncoder().encode('l4-local-compute-v1\n' + new URL(env.PUBLIC_ORIGIN).origin + '\n' + raw))
  if (!valid) fail(403, 'local_compute_denied', 'Invalid local signature')
  const input = z.object({ nodeId: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/u), timestamp: z.number().int(), capabilities: dockerCapabilities }).strict().parse(JSON.parse(raw))
  if (Math.abs(Date.now() - input.timestamp) > 60000) fail(403, 'local_compute_expired', 'Local pairing expired')
  const owner = await env.DB.prepare('SELECT owner_id AS id FROM server WHERE owner_id IS NOT NULL').first<{ id: string }>()
  if (!owner) fail(409, 'owner_required', 'Claim the Server Owner before local pairing')
  const hash = await factoryHash(input.token)
  await env.DB.prepare(`INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at)
    VALUES(?,'Local VPS executor',?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(input.nodeId, hash, JSON.stringify(input.capabilities), nowIso(), owner.id, nowIso()).run()
  const node = await env.DB.prepare('SELECT token_hash AS hash,enabled,capabilities_json AS capabilitiesJson FROM compute_nodes WHERE id=?').bind(input.nodeId).first<{ hash: string; enabled: number; capabilitiesJson: string }>()
  if (!node?.enabled || node.hash !== hash || node.capabilitiesJson !== JSON.stringify(input.capabilities)) fail(409, 'local_compute_changed', 'Local pairing was already consumed or revoked')
  setHeader(event, 'Cache-Control', 'private, no-store')
  return { serverId: await getServerId(env.DB) }
})
