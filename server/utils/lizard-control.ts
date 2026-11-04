import type { L4Env } from '../../workers/env'
import { asRpc } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { newId } from '../../shared/ids'
import { getServerId } from '../../shared/server-id'
import { prepareComputePairing, requireComputeOwner } from './compute-nodes'
import { fail } from './cf'
import { lizardCredential } from './lizard-connection'

type Status = { phase: string; workspaceId: string | null; nodeId: string | null; error: string | null; retainedStorage: boolean; paused: boolean; expiresAt: number | null }
type Controller = { status(): Promise<Status>; start(workspaceId: string, pairing?: string): Promise<Status>; stop(): Promise<Status>; ensure(nodeId: string): Promise<Status>; discardUnusedStorage(): Promise<Status> }
async function control(env: L4Env) {
  if (!env.LIZARD_COMPUTE_DO) fail(503, 'lizard_control_unavailable', 'Lizard compute control is not available on this Server')
  return asRpc<Controller>(env.LIZARD_COMPUTE_DO.getByName('lizard:' + await getServerId(env.DB)))
}
export async function lizardComputeStatus(env: L4Env, actor: AuthorizationContext) {
  requireComputeOwner(actor)
  return (await control(env)).status()
}
export async function startLizardCompute(env: L4Env, actor: AuthorizationContext) {
  requireComputeOwner(actor)
  await lizardCredential(env)
  const provider = await control(env), current = await provider.status()
  if (current.phase !== 'stopped') return current
  if (current.workspaceId && current.nodeId && current.retainedStorage) return provider.start(current.workspaceId)
  const workspaceId = newId(), pairing = await prepareComputePairing(env, actor, 'Lizard ' + workspaceId)
  return provider.start(workspaceId, pairing.token)
}
export async function stopLizardCompute(env: L4Env, actor: AuthorizationContext) {
  requireComputeOwner(actor)
  return (await control(env)).stop()
}
export async function ensureLizardCompute(env: L4Env, nodeId: string) {
  const result = await (await control(env)).ensure(nodeId)
  if (result.phase === 'failed') fail(503, 'lizard_compute_failed', 'Lizard compute requires operator attention')
  return result
}
export async function discardUnusedLizardStorage(env: L4Env, actor: AuthorizationContext) {
  requireComputeOwner(actor)
  return (await control(env)).discardUnusedStorage()
}
