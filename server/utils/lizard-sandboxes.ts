import { z } from 'zod'
import type { L4Env } from '../../workers/env'
import { lizardCredential } from './lizard-connection'
import { fail } from './cf'

const endpoint = 'https://lizard.build/api'
const sandboxId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u)
const createResult = z.object({ sandboxId: sandboxId.optional(), id: sandboxId.optional() }).refine(value => value.sandboxId || value.id)
const config = z.object({ workspaceId: z.string().uuid(), timeoutMs: z.number().int().min(60000).max(600000), region: z.string().regex(/^[a-z0-9-]{1,64}$/u), size: z.enum(['small', 'medium', 'large']) }).strict()
/** A timed-out create is an unknown outcome. Callers must reconcile by workspace identity; never retry blindly. */
export async function createLizardSandbox(env: L4Env, input: z.infer<typeof config>) {
  const values = config.parse(input), credential = await lizardCredential(env)
  let response: Response
  try {
    response = await fetch(endpoint + '/sandboxes', { method: 'POST', headers: { 'X-API-Key': credential.apiKey, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000), body: JSON.stringify({ template: 'base', projectId: credential.projectId, size: values.size, region: values.region, timeoutMs: values.timeoutMs, metadata: { l4Workspace: values.workspaceId } }) })
  } catch { fail(503, 'lizard_create_uncertain', 'Lizard VM creation outcome is unknown; inspect the provider before retrying') }
  if (!response.ok) fail(response.status >= 500 ? 503 : 400, 'lizard_create_failed', 'Lizard did not accept the VM request')
  let parsed: z.infer<typeof createResult>
  try { parsed = createResult.parse(await response.json()) }
  catch { fail(503, 'lizard_create_uncertain', 'Lizard returned an unrecognized VM response; inspect the provider before retrying') }
  return { sandboxId: parsed.sandboxId ?? parsed.id! }
}
/** The caller must verify this exact VM belongs to its workspace before deletion. */
export async function deleteLizardSandbox(env: L4Env, id: string) {
  const safeId = sandboxId.parse(id), credential = await lizardCredential(env)
  let response: Response
  try { response = await fetch(endpoint + '/sandboxes/' + encodeURIComponent(safeId), { method: 'DELETE', headers: { 'X-API-Key': credential.apiKey }, redirect: 'error', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_delete_uncertain', 'Lizard VM cleanup outcome is unknown; inspect the provider') }
  if (!response.ok && response.status !== 404) fail(503, 'lizard_delete_failed', 'Lizard VM cleanup failed')
  return { deleted: true }
}
