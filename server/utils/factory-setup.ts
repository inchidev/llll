import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { cloudflareCapabilities, factoryProbeRepositoryName } from '../../shared/software-factory'
import { requireComputeOwner } from './compute-nodes'
import { factoryHash } from './factory-authority'
import { getServerId } from '../../shared/server-id'
import { newId, nowIso } from '../../shared/ids'
import { fail } from './cf'

export async function factorySetup(env: L4Env, auth: AuthorizationContext) {
  requireComputeOwner(auth)
  const nodes = await env.DB.prepare('SELECT id,name,enabled,last_seen AS lastSeen,capabilities_json AS capabilitiesJson FROM compute_nodes ORDER BY created_at').all<{ id: string; name: string; enabled: number; lastSeen: string | null; capabilitiesJson: string }>()
  const placement = env.LLLL_RUNTIME?.trim().toLowerCase() === 'celld' ? 'vps' : 'cloudflare'
  const cloud = nodes.results.find(node => placement === 'vps' ? node.name === 'Local VPS executor' : JSON.parse(node.capabilitiesJson).provider === 'cloudflare-containers')
  const limits = cloud ? JSON.parse(cloud.capabilitiesJson) : env.FACTORY_POLICY ? JSON.parse(env.FACTORY_POLICY) : null
  const resources = Boolean(env.FACTORY_COMPUTE && env.FACTORY_CODE && env.FACTORY_IMAGE)
  const serverId = await getServerId(env.DB)
  const usage = cloud ? await env.DB.prepare("SELECT (SELECT count(*) FROM factory_workspaces WHERE node_id=? AND status<>'released') AS retained, (SELECT count(*) FROM factory_actions a JOIN factory_workspaces w ON w.id=a.workspace_id WHERE w.node_id=? AND a.status IN ('claimed','executing')) AS active, (SELECT count(*) FROM factory_actions a JOIN factory_workspaces w ON w.id=a.workspace_id WHERE w.node_id=? AND a.status='uncertain') AS recoveryRequired").bind(cloud.id, cloud.id, cloud.id).first<{ retained: number; active: number; recoveryRequired: number }>() : null
  return { placement, resources, usage, state: cloud ? cloud.enabled ? usage?.recoveryRequired ? 'failed_recovery' : 'ready' : 'paused' : resources ? 'disabled' : 'unavailable',
    nodeId: cloud?.id ?? null, image: env.FACTORY_IMAGE ?? limits?.image ?? null, limits,
    connectUrl: placement === 'cloudflare' && env.ACCOUNT_ID ? `https://llll.gg/create?tab=cloudflare&factory=1&account=${encodeURIComponent(env.ACCOUNT_ID)}&worker=${encodeURIComponent('llll-' + serverId)}&server=${encodeURIComponent(env.PUBLIC_ORIGIN ?? '')}` : null,
    cli: placement === 'vps' ? 'sudo llll compute enable --trust-shared-kernel' : null,
    durability: 'Task code, Git history and pending source edits are checkpointed. Dependencies, build output, process memory and running services are disposable.',
    costs: placement === 'vps'
      ? 'This VPS executor uses your host CPU, disk and network. Model-provider usage is billed separately.'
      : 'Cloudflare compute, code storage and network usage are billed separately from model-provider usage. Activation does not upgrade your plan.' }
}
function artifactToken(token: unknown) {
  if (typeof token === 'string' && token) return token
  if (token && typeof token === 'object' && 'id' in token && typeof token.id === 'string') return token.id
  return ''
}
export async function configureCloudflareFactory(env: L4Env, auth: AuthorizationContext, enabled: boolean) {
  requireComputeOwner(auth)
  if (!env.FACTORY_COMPUTE || !env.FACTORY_CODE || !env.FACTORY_IMAGE) fail(409, 'factory_resources_required', 'Authorize optional Containers and Artifacts through the installer first. Workers Paid is required; R2 is independent.')
  if (enabled) {
    if (await env.DB.prepare("SELECT 1 FROM server_settings WHERE key='factory.provisioning'").first()) fail(409, 'factory_provisioning', 'Factory provisioning is incomplete. Resume it in the installer before activation.')
    const serverId = await getServerId(env.DB)
    let probe: Response
    try { probe = await env.FACTORY_COMPUTE.getByName(`probe:${serverId}`).fetch(new Request('http://factory/probe', { method: 'POST' })) }
    catch { fail(503, 'factory_provisioning', 'Container resources are still provisioning or unavailable. Retry activation after checking provider access.') }
    if (!probe.ok) {
      let detail = ''
      try {
        const body = await probe.json() as { message?: string }
        if (body?.message) detail = ` ${body.message}`
      } catch { /* The status is enough when the probe body is not JSON. */ }
      fail(503, 'factory_provisioning', `Container resources are still provisioning or unavailable.${detail} Retry activation after checking provider access.`)
    }
    const name = factoryProbeRepositoryName(serverId, newId())
    try {
      const created = await env.FACTORY_CODE.create(name)
      const token = artifactToken(created.token)
      if (!token) throw new Error('Artifacts did not return a revocable token')
      let repository: Awaited<ReturnType<NonNullable<L4Env['FACTORY_CODE']>['get']>> | undefined
      try { repository = await env.FACTORY_CODE.get(name) }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); repository = await env.FACTORY_CODE.get(name) }
      using handle = repository
      await handle.revokeToken(token)
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) throw error
      const message = error instanceof Error && error.message ? error.message : 'Artifacts request failed'
      fail(502, 'factory_artifacts', `Factory code storage is unavailable: ${message}. Reconnect Cloudflare and approve Artifacts Read and Artifacts Write, then provision again.`)
    } finally { await env.FACTORY_CODE.delete(name).catch(() => undefined) }
  }
  const existing = await env.DB.prepare("SELECT id,capabilities_json AS capabilitiesJson FROM compute_nodes WHERE json_extract(capabilities_json,'$.provider')='cloudflare-containers' ORDER BY created_at LIMIT 1").first<{ id: string; capabilitiesJson: string }>()
  const limits = env.FACTORY_POLICY ? JSON.parse(env.FACTORY_POLICY) : { diskBytes: 8000000000, cpu: 0.5, memoryMiB: 4096, processLimit: 128, timeoutMs: 120000 }
  const capabilities = cloudflareCapabilities.parse({ provider: 'cloudflare-containers', diskBytes: 8000000000, docker: false, durableDisk: false, isolation: 'container-vm',
    image: env.FACTORY_IMAGE, maxParallel: 1, protocol: 1, cpu: 0.5, memoryMiB: 4096, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000, ...limits })
  const nodeId = existing?.id ?? newId()
  if (existing && existing.capabilitiesJson !== JSON.stringify(capabilities)) fail(409, 'factory_image_changed', 'The Factory image changed. Preserve/export existing Task source and explicitly configure a new provider for new Tasks.')
  if (!existing && enabled) {
    const inserted = await env.DB.prepare("INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM server_settings WHERE key='factory.provisioning') RETURNING id")
      .bind(nodeId, 'Cloudflare Factory', await factoryHash(newId() + newId()), JSON.stringify(capabilities), nowIso(), auth.principal.id, nowIso()).first()
    if (!inserted) fail(409, 'factory_provisioning', 'Factory provisioning changed during activation. Resume it in the installer before retrying.')
  } else if (existing) {
    await env.DB.batch([
      env.DB.prepare('UPDATE compute_nodes SET enabled=?,last_seen=? WHERE id=?').bind(enabled ? 1 : 0, nowIso(), nodeId),
      env.DB.prepare("UPDATE factory_actions SET status=CASE WHEN status IN ('claimed','executing') THEN 'uncertain' ELSE 'cancelled' END WHERE workspace_id IN (SELECT id FROM factory_workspaces WHERE node_id=?) AND status IN ('pending','approved','claimed','executing') AND ?=0").bind(nodeId, enabled ? 1 : 0),
    ])
  }
  return factorySetup(env, auth)
}
export async function dispatchCloudflareFactory(env: L4Env, actionId: string, workspaceId: string, nodeId: string) {
  const node = await env.DB.prepare('SELECT capabilities_json AS capabilitiesJson FROM compute_nodes WHERE id=? AND enabled=1').bind(nodeId).first<{ capabilitiesJson: string }>()
  if (node && JSON.parse(node.capabilitiesJson).provider === 'lizard') {
    const { ensureLizardCompute } = await import('./lizard-control')
    await ensureLizardCompute(env, nodeId)
    return
  }
  if (!env.FACTORY_COMPUTE) return
  if (node && JSON.parse(node.capabilitiesJson).provider === 'cloudflare-containers') {
    const result = await env.FACTORY_COMPUTE.getByName(`workspace:${workspaceId}`).fetch(new Request(`http://factory/${actionId}`, { method: 'POST' }))
    if (!result.ok) fail(503, 'factory_dispatch_failed', 'Factory is unavailable; the approved action remains recorded')
  }
}
