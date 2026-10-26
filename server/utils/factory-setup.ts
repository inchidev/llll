import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { cloudflareCapabilities } from '../../shared/software-factory'
import { requireComputeOwner } from './compute-nodes'
import { factoryHash } from './factory-authority'
import { getServerId } from '../../shared/server-id'
import { newId, nowIso } from '../../shared/ids'
import { fail } from './cf'

export async function factorySetup(env: L4Env, auth: AuthorizationContext) {
  requireComputeOwner(auth)
  const nodes = await env.DB.prepare('SELECT id,name,enabled,last_seen AS lastSeen,capabilities_json AS capabilitiesJson FROM compute_nodes ORDER BY created_at').all<{ id: string; name: string; enabled: number; lastSeen: string | null; capabilitiesJson: string }>()
  const placement = env.LLLL_RUNTIME === 'celld' ? 'vps' : 'cloudflare'
  const cloud = nodes.results.find(node => placement === 'vps' ? node.name === 'Local VPS executor' : JSON.parse(node.capabilitiesJson).provider === 'cloudflare-containers')
  const limits = cloud ? JSON.parse(cloud.capabilitiesJson) : env.FACTORY_POLICY ? JSON.parse(env.FACTORY_POLICY) : null
  const resources = Boolean(env.FACTORY_COMPUTE && env.FACTORY_CODE && env.FACTORY_IMAGE)
  const serverId = await getServerId(env.DB)
  return { placement, resources, state: cloud ? cloud.enabled ? 'ready' : 'paused' : resources ? 'disabled' : 'unavailable',
    nodeId: cloud?.id ?? null, image: env.FACTORY_IMAGE ?? limits?.image ?? null, limits,
    connectUrl: placement === 'cloudflare' && env.ACCOUNT_ID ? `https://llll.gg/create?tab=cloudflare&factory=1&account=${encodeURIComponent(env.ACCOUNT_ID)}&worker=${encodeURIComponent('llll-' + serverId)}&server=${encodeURIComponent(env.PUBLIC_ORIGIN ?? '')}` : null,
    cli: placement === 'vps' ? 'sudo llll factory enable --trust-shared-kernel' : null,
    durability: 'Task code, Git history and pending source edits are checkpointed. Dependencies, build output, process memory and running services are disposable.',
    costs: 'Cloudflare compute, code storage and network usage are billed separately from model-provider usage. Activation does not upgrade your plan.' }
}
export async function configureCloudflareFactory(env: L4Env, auth: AuthorizationContext, enabled: boolean) {
  requireComputeOwner(auth)
  if (!env.FACTORY_COMPUTE || !env.FACTORY_CODE || !env.FACTORY_IMAGE) fail(409, 'factory_resources_required', 'Authorize optional Containers and Artifacts through the installer first. Workers Paid is required; R2 is independent.')
  if (enabled) {
    const serverId = await getServerId(env.DB)
    const probe = await env.FACTORY_COMPUTE.getByName(`probe:${serverId}`).fetch(new Request('http://factory/probe', { method: 'POST' }))
    if (!probe.ok) fail(503, 'factory_provisioning', 'Container resources are still provisioning or unavailable. Retry activation after checking provider access.')
    const name = `l4-probe-${serverId.replaceAll('-', '')}-${newId().replaceAll('-', '')}`
    const created = await env.FACTORY_CODE.create(name)
    try { using repository = await env.FACTORY_CODE.get(name); await repository.revokeToken(created.token) }
    finally { await env.FACTORY_CODE.delete(name) }
  }
  const existing = await env.DB.prepare("SELECT id,capabilities_json AS capabilitiesJson FROM compute_nodes WHERE json_extract(capabilities_json,'$.provider')='cloudflare-containers' ORDER BY created_at LIMIT 1").first<{ id: string; capabilitiesJson: string }>()
  const limits = env.FACTORY_POLICY ? JSON.parse(env.FACTORY_POLICY) : { diskBytes: 8000000000, cpu: 0.5, memoryMiB: 4096, processLimit: 128, timeoutMs: 120000 }
  const capabilities = cloudflareCapabilities.parse({ provider: 'cloudflare-containers', diskBytes: 8000000000, docker: false, durableDisk: false, isolation: 'container-vm',
    image: env.FACTORY_IMAGE, maxParallel: 1, protocol: 1, cpu: 0.5, memoryMiB: 4096, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000, ...limits })
  const nodeId = existing?.id ?? newId()
  if (existing && existing.capabilitiesJson !== JSON.stringify(capabilities)) fail(409, 'factory_image_changed', 'The Factory image changed. Preserve/export existing Task source and explicitly configure a new provider for new Tasks.')
  if (!existing && enabled) {
    await env.DB.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(nodeId, 'Cloudflare Factory', await factoryHash(newId() + newId()), JSON.stringify(capabilities), nowIso(), auth.principal.id, nowIso()).run()
  } else if (existing) {
    await env.DB.batch([
      env.DB.prepare('UPDATE compute_nodes SET enabled=?,last_seen=? WHERE id=?').bind(enabled ? 1 : 0, nowIso(), nodeId),
      env.DB.prepare("UPDATE factory_actions SET status=CASE WHEN status IN ('claimed','executing') THEN 'uncertain' ELSE 'cancelled' END WHERE workspace_id IN (SELECT id FROM factory_workspaces WHERE node_id=?) AND status IN ('pending','approved','claimed','executing') AND ?=0").bind(nodeId, enabled ? 1 : 0),
    ])
  }
  return factorySetup(env, auth)
}
export async function dispatchCloudflareFactory(env: L4Env, actionId: string, workspaceId: string, nodeId: string) {
  if (!env.FACTORY_COMPUTE) return
  const node = await env.DB.prepare('SELECT capabilities_json AS capabilitiesJson FROM compute_nodes WHERE id=? AND enabled=1').bind(nodeId).first<{ capabilitiesJson: string }>()
  if (node && JSON.parse(node.capabilitiesJson).provider === 'cloudflare-containers') {
    const result = await env.FACTORY_COMPUTE.getByName(`workspace:${workspaceId}`).fetch(new Request(`http://factory/${actionId}`, { method: 'POST' }))
    if (!result.ok) fail(503, 'factory_dispatch_failed', 'Factory is unavailable; the approved action remains recorded')
  }
}
