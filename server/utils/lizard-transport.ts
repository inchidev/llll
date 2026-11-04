import { z } from 'zod'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { lizardCredential } from './lizard-connection'
import { fail } from './cf'
const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u)
const safePath = z.string().regex(/^\/workspace\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/u).max(400)
const resultSchema = z.object({ stdout: z.string().max(400000), stderr: z.string().max(400000), exitCode: z.number().int() })
async function request(env: L4Env, id: string, path: string, body: unknown, timeoutMs: number) {
  safeId.parse(id)
  const { apiKey } = await lizardCredential(env)
  let response: Response
  try { response = await fetch(`https://lizard.build/api/sandboxes/${encodeURIComponent(id)}${path}`, { method: 'POST', headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }) }
  catch { fail(503, 'lizard_transport_uncertain', 'Lizard request outcome is unknown; inspect it before retrying') }
  if (!response.ok) fail(503, 'lizard_transport_failed', 'Lizard could not execute the requested setup step')
  const output = await readLimitedStream(response.body, 900000)
  if (!output.ok) fail(503, 'lizard_transport_invalid', 'Lizard setup response exceeded its limit')
  try { return JSON.parse(new TextDecoder().decode(output.bytes)) as unknown }
  catch { fail(503, 'lizard_transport_invalid', 'Lizard setup response was invalid') }
}
/** Only the Server-owned bootstrap supplies these fixed commands. Never pass model text here. */
export async function execLizardBootstrap(env: L4Env, id: string, cmd: string | string[], options: { timeoutMs: number; workdir?: string; envs?: Record<string, string> }) {
  if (options.timeoutMs < 1000 || options.timeoutMs > 180000) fail(400, 'lizard_timeout', 'Invalid setup timeout')
  const result = resultSchema.safeParse(await request(env, id, '/exec', { cmd, ...options }, options.timeoutMs + 10000))
  if (!result.success || result.data.exitCode !== 0) fail(503, 'lizard_setup_failed', 'Lizard compute setup failed')
  return result.data
}
export async function writeLizardBootstrapFile(env: L4Env, id: string, path: string, content: string) {
  safePath.parse(path)
  if (content.length > 150000) fail(400, 'lizard_file_limit', 'Compute setup file is too large')
  await request(env, id, '/files', { path, content }, 30000)
}
export async function exposeLizardBridge(env: L4Env, id: string) {
  const value = z.object({ hostname: z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.onlizard\.com$/u), accessToken: z.string().min(16).max(500) }).safeParse(await request(env, id, '/expose/3900', {}, 30000))
  if (!value.success) fail(503, 'lizard_expose_invalid', 'Lizard returned an invalid bridge endpoint')
  return value.data
}
