import { z } from 'zod'
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { requireComputeOwner } from './compute-nodes'
import { fail } from './cf'
import { readLimitedStream } from '../../workers/inbound-email-signature'

const key = 'compute.lizard.connection'
const projectsSchema = z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200) }).passthrough()).max(1000)
type Saved = { secret: EncryptedSecret; projectId: string; projectName: string; checkedAt: string }
async function projects(apiKey: string) {
  let response: Response
  try { response = await fetch('https://lizard.build/api/projects', { headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) }) }
  catch { fail(502, 'lizard_unavailable', 'Could not connect to Lizard') }
  if (!response.ok) fail(response.status === 401 || response.status === 403 ? 403 : 502, 'lizard_connection_failed', 'Lizard rejected the connection or is unavailable')
  const data = await readLimitedStream(response.body, 1000000)
  if (!data.ok) fail(502, 'lizard_response', 'Lizard response was too large')
  try { return projectsSchema.parse(JSON.parse(new TextDecoder().decode(data.bytes))).map(({ id, name }) => ({ id, name })) }
  catch { fail(502, 'lizard_response', 'Lizard returned an unexpected project list') }
}
export async function getLizardConnection(env: L4Env, auth: AuthorizationContext) {
  requireComputeOwner(auth)
  const raw = await readServerSetting(env.DB, key)
  if (!raw) return { connection: null }
  const value = JSON.parse(raw) as Saved
  return { connection: { projectId: value.projectId, projectName: value.projectName, checkedAt: value.checkedAt, executionAvailable: false } }
}
export async function checkLizardConnection(env: L4Env, auth: AuthorizationContext, apiKey: string) {
  requireComputeOwner(auth)
  if (!apiKey.trim() || apiKey.length > 500) fail(400, 'lizard_key', 'Enter a valid Lizard API key')
  return { projects: await projects(apiKey.trim()) }
}
export async function saveLizardConnection(env: L4Env, auth: AuthorizationContext, apiKey: string, projectId: string) {
  requireComputeOwner(auth)
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const available = await checkLizardConnection(env, auth, apiKey)
  const project = available.projects.find(item => item.id === projectId)
  if (!project) fail(403, 'lizard_project', 'Project is not available to this Lizard key')
  const saved: Saved = { secret: await encryptSecret(env.AUTH_SECRET, key, apiKey.trim()), projectId: project.id, projectName: project.name, checkedAt: new Date().toISOString() }
  await writeServerSetting(env.DB, key, JSON.stringify(saved))
  return getLizardConnection(env, auth)
}
export async function lizardCredential(env: L4Env) {
  if (!env.AUTH_SECRET) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const raw = await readServerSetting(env.DB, key)
  if (!raw) fail(409, 'lizard_unconfigured', 'Lizard is not connected')
  const saved = JSON.parse(raw) as Saved
  return { apiKey: await decryptSecret(env.AUTH_SECRET, key, saved.secret), projectId: saved.projectId }
}
export async function removeLizardConnection(env: L4Env, auth: AuthorizationContext) {
  requireComputeOwner(auth)
  await env.DB.prepare('DELETE FROM server_settings WHERE key=?').bind(key).run()
  return { disconnected: true }
}
