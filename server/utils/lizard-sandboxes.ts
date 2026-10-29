import { z } from 'zod'
import type { L4Env } from '../../workers/env'
import { lizardCredential } from './lizard-connection'
import { fail } from './cf'
import { readLimitedStream } from '../../workers/inbound-email-signature'

const endpoint = 'https://lizard.build/api'
const sandboxId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u)
const createResult = z.object({ sandboxId: sandboxId.optional(), id: sandboxId.optional() }).refine(value => value.sandboxId || value.id)
const sandboxList = z.array(z.object({ sandboxId: sandboxId.optional(), id: sandboxId.optional(), metadata: z.record(z.string(), z.string()).optional() })).max(1000)
const config = z.object({ workspaceId: z.string().uuid(), timeoutMs: z.number().int().min(60000).max(600000), region: z.string().regex(/^[a-z0-9-]{1,64}$/u), size: z.enum(['small', 'medium', 'large']), volumeId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u).optional() }).strict()
async function boundedJson(response: Response) {
  const data = await readLimitedStream(response.body, 1000000)
  if (!data.ok) throw new Error('Provider response exceeded limit')
  return JSON.parse(new TextDecoder().decode(data.bytes)) as unknown
}
/** A timed-out create is an unknown outcome. Callers must reconcile by workspace identity; never retry blindly. */
export async function createLizardSandbox(env: L4Env, input: z.infer<typeof config>) {
  const values = config.parse(input), credential = await lizardCredential(env)
  let response: Response
  try {
    response = await fetch(endpoint + '/sandboxes', { method: 'POST', headers: { 'X-API-Key': credential.apiKey, 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(30000), body: JSON.stringify({ template: 'base', projectId: credential.projectId, size: values.size, region: values.region, timeoutMs: values.timeoutMs, volumeId: values.volumeId, metadata: { l4Workspace: values.workspaceId } }) })
  } catch { fail(503, 'lizard_create_uncertain', 'Lizard VM creation outcome is unknown; inspect the provider before retrying') }
  if (!response.ok) fail(response.status >= 500 ? 503 : 400, 'lizard_create_failed', 'Lizard did not accept the VM request')
  let parsed: z.infer<typeof createResult>
  try { parsed = createResult.parse(await boundedJson(response)) }
  catch { fail(503, 'lizard_create_uncertain', 'Lizard returned an unrecognized VM response; inspect the provider before retrying') }
  return { sandboxId: parsed.sandboxId ?? parsed.id! }
}
/** Delete only a VM that declares the exact workspace ownership marker we assigned. */
export async function deleteLizardSandbox(env: L4Env, id: string, workspaceId: string) {
  const safeId = sandboxId.parse(id), credential = await lizardCredential(env)
  z.string().uuid().parse(workspaceId)
  let response: Response
  const url = endpoint + '/sandboxes/' + encodeURIComponent(safeId), headers = { 'X-API-Key': credential.apiKey }
  try { response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_delete_uncertain', 'Lizard VM ownership could not be checked') }
  if (response.status === 404) return { deleted: true }
  if (!response.ok) fail(503, 'lizard_delete_failed', 'Lizard VM ownership could not be checked')
  let owner: { metadata?: Record<string, string> }
  try { owner = z.object({ metadata: z.record(z.string(), z.string()).optional() }).parse(await boundedJson(response)) }
  catch { fail(503, 'lizard_delete_uncertain', 'Lizard VM ownership response was invalid') }
  if (owner.metadata?.l4Workspace !== workspaceId) fail(403, 'lizard_delete_denied', 'Lizard VM belongs to a different workspace')
  try { response = await fetch(url, { method: 'DELETE', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_delete_uncertain', 'Lizard VM cleanup outcome is unknown; inspect the provider') }
  if (!response.ok && response.status !== 404) fail(503, 'lizard_delete_failed', 'Lizard VM cleanup failed')
  return { deleted: true }
}
/** Reconcile a timed-out create by its unique workspace marker before considering another create. */
export async function listOwnedLizardSandboxes(env: L4Env, workspaceId: string) {
  z.string().uuid().parse(workspaceId)
  const credential = await lizardCredential(env)
  let response: Response
  try { response = await fetch(endpoint + '/projects/' + encodeURIComponent(credential.projectId) + '/sandboxes', { headers: { 'X-API-Key': credential.apiKey }, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_list_unavailable', 'Lizard VM inventory is unavailable') }
  if (!response.ok) fail(503, 'lizard_list_unavailable', 'Lizard VM inventory is unavailable')
  let items: z.infer<typeof sandboxList>
  try { items = sandboxList.parse(await boundedJson(response)) }
  catch { fail(503, 'lizard_list_invalid', 'Lizard VM inventory is invalid') }
  // The project listing can omit metadata. Check each candidate's detail before
  // treating it as ours; an omitted marker must never be assumed to mean ours.
  const matches: string[] = []
  for (const item of items) {
    const id = item.sandboxId ?? item.id
    if (!id) continue
    if (item.metadata?.l4Workspace === workspaceId) { matches.push(id); continue }
    if (item.metadata) continue
    let detail: Response
    try { detail = await fetch(endpoint + '/sandboxes/' + encodeURIComponent(id), { headers: { 'X-API-Key': credential.apiKey }, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
    catch { fail(503, 'lizard_list_unavailable', 'Lizard VM ownership could not be checked') }
    if (detail.status === 404) continue
    if (!detail.ok) fail(503, 'lizard_list_unavailable', 'Lizard VM ownership could not be checked')
    let parsed: { metadata?: Record<string, string> }
    try { parsed = z.object({ metadata: z.record(z.string(), z.string()).optional() }).parse(await boundedJson(detail)) }
    catch { fail(503, 'lizard_list_invalid', 'Lizard VM ownership response was invalid') }
    if (parsed.metadata?.l4Workspace === workspaceId) matches.push(id)
  }
  return matches
}
/** Extend only the VM carrying this workspace's marker; never leave it unbounded. */
export async function extendLizardSandbox(env: L4Env, id: string, workspaceId: string) {
  const safeId = sandboxId.parse(id), credential = await lizardCredential(env)
  z.string().uuid().parse(workspaceId)
  const base = endpoint + '/sandboxes/' + encodeURIComponent(safeId), headers = { 'X-API-Key': credential.apiKey }
  let info: Response
  try { info = await fetch(base, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_extend_uncertain', 'Lizard VM ownership could not be checked') }
  if (!info.ok) fail(503, 'lizard_extend_failed', 'Lizard VM is unavailable')
  let owner: { metadata?: Record<string, string> }
  try { owner = z.object({ metadata: z.record(z.string(), z.string()).optional() }).parse(await boundedJson(info)) }
  catch { fail(503, 'lizard_extend_uncertain', 'Lizard VM ownership response was invalid') }
  if (owner.metadata?.l4Workspace !== workspaceId) fail(403, 'lizard_extend_denied', 'Lizard VM belongs to a different workspace')
  let response: Response
  try { response = await fetch(base + '/timeout', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: 600000 }), redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_extend_uncertain', 'Lizard VM expiry could not be confirmed') }
  if (!response.ok) fail(503, 'lizard_extend_failed', 'Lizard VM expiry could not be extended')
  return { expiresAt: Date.now() + 600000 }
}
