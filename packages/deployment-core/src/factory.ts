import { sha256 as streamingSha256 } from '@noble/hashes/sha2.js'
import { cloudflareApi, cloudflareClient } from './cloudflare-client.js'
import { readL4Server } from './servers.js'
import { loadL4Release, releaseManifestUrl } from './release.js'
import { createError } from './errors.js'
import { factoryScriptContainer } from './factory-bindings.js'

type FactoryAsset = { sha256: string; size: number }
type FactoryRelease = { schemaVersion: number; version: string; manifestDigest: string; files: Record<string, FactoryAsset>; layers: { file: string; digest: string; size: number }[] }
const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
async function verified(url: string, asset: FactoryAsset, maximum = 96000000) {
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maximum || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new Error('Invalid Factory asset descriptor')
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!response.ok || Number(response.headers.get('content-length') || asset.size) > maximum) throw new Error('Published Factory asset unavailable or too large')
  const chunks: Uint8Array[] = []; let length = 0
  if (!response.body) throw new Error('Missing Factory asset body')
  const reader = response.body.getReader()
  try { for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; length += chunk.length; if (length > asset.size) { await reader.cancel(); throw new Error('Factory asset size mismatch') }; chunks.push(chunk) } } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (length !== asset.size || await digest(bytes.buffer) !== asset.sha256) throw new Error('Factory asset checksum mismatch')
  return bytes.buffer
}

function artifactsStatus(error: unknown) {
  if (!error || typeof error !== 'object') return 0
  const value = error as { statusCode?: unknown; status?: unknown }
  return Number(value.statusCode || value.status || 0)
}

async function ensureArtifactsNamespace(accessToken: string, accountId: string, namespace: string) {
  const missing = 'Reconnect Cloudflare and approve Artifacts Read and Artifacts Write. Factory code storage cannot be provisioned without those permissions.'
  const denied = (error: unknown) => {
    const status = artifactsStatus(error)
    if (status === 401 || status === 403) throw createError({ statusCode: 403, statusMessage: missing })
    return status
  }
  try {
    await cloudflareApi(accessToken, `/accounts/${accountId}/artifacts/namespaces/${encodeURIComponent(namespace)}`)
    return
  } catch (error) {
    if (denied(error) !== 404) throw error
  }
  try {
    await cloudflareApi(accessToken, `/accounts/${accountId}/artifacts/namespaces`, { method: 'POST', body: JSON.stringify({ namespace }) })
  } catch (error) {
    denied(error)
    throw error
  }
}

/** Browser-session grant only. No account token is persisted in the customer Server. */
export async function enableL4Factory(accessToken: string, accountId: string, workerName: string, paidConsent: boolean, policy: { size?: 'small' | 'standard' | 'large'; timeoutSeconds?: number; processes?: number } = {}) {
  if (!paidConsent) throw createError({ statusCode: 400, statusMessage: 'Review and explicitly authorize paid Containers and Artifacts usage first' })
  const server = await readL4Server(accessToken, accountId, workerName)
  if (!server?.version) throw createError({ statusCode: 404, statusMessage: 'Select an installed L4 Server' })
  // Check available APIs before allocating or modifying anything. No subscription or plan upgrade call exists here.
  await cloudflareApi(accessToken, `/accounts/${accountId}/containers/me`)
  const namespace = `${workerName}-factory`
  await ensureArtifactsNamespace(accessToken, accountId, namespace)
  const sizes = { small: { instance_type: 'basic', cpu: 0.25, memoryMiB: 1024, diskBytes: 4000000000 }, standard: { instance_type: 'standard-1', cpu: 0.5, memoryMiB: 4096, diskBytes: 8000000000 }, large: { instance_type: 'standard-2', cpu: 1, memoryMiB: 6144, diskBytes: 12000000000 } }
  const size = sizes[policy.size ?? 'standard'], timeoutSeconds = policy.timeoutSeconds ?? 120, processes = policy.processes ?? 128
  if (!size || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600 || !Number.isInteger(processes) || processes < 32 || processes > 512) throw new Error('Invalid Factory resource policy')
  const limits = { cpu: size.cpu, memoryMiB: size.memoryMiB, diskBytes: size.diskBytes, timeoutMs: timeoutSeconds * 1000, processLimit: processes }
  const release = await loadL4Release(releaseManifestUrl(server.version))
  const descriptor = release.manifest.factory
  if (!descriptor) throw createError({ statusCode: 409, statusMessage: 'Update this Server to a published release with Factory installer artifacts first' })
  const factoryBytes = await verified(descriptor.url, descriptor, 100000)
  const factory: FactoryRelease = JSON.parse(new TextDecoder().decode(factoryBytes))
  if (factory.schemaVersion !== 1 || factory.version !== server.version || !/^sha256:[a-f0-9]{64}$/u.test(factory.manifestDigest)) throw new Error('Factory release identity mismatch')
  const base = new URL('.', descriptor.url).toString()
  const client = cloudflareClient(accessToken)
  const before = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
  const existing = before.bindings ?? []
  const boundPolicy = existing.find(binding => binding.name === 'FACTORY_POLICY')
  if (boundPolicy && 'text' in boundPolicy && boundPolicy.text !== JSON.stringify(limits)) throw createError({ statusCode: 409, statusMessage: 'Existing Factory limits are bound to active Task authority. Pause and explicitly replace the provider before changing its policy.' })
  const boundImage = existing.find(binding => binding.name === 'FACTORY_IMAGE')
  if (boundImage && 'text' in boundImage && typeof boundImage.text === 'string' && !boundImage.text.endsWith('@' + factory.manifestDigest)) throw createError({ statusCode: 409, statusMessage: 'Preserve/export existing Factory Task source before explicitly replacing its pinned image' })
  const credentials = await cloudflareApi<{ username: string; password: string }>(accessToken, `/accounts/${accountId}/containers/registries/registry.cloudflare.com/credentials`, { method: 'POST', body: JSON.stringify({ expiration_minutes: 15, permissions: ['push', 'pull'] }) })
  const authorization = 'Basic ' + btoa(`${credentials.username}:${credentials.password}`)
  const registry = `https://registry.cloudflare.com/v2/${accountId}/${workerName}-factory`
  const registryRequest = async (url: string, init: RequestInit) => {
    if (!url.startsWith(registry + '/')) throw new Error('Unexpected image registry upload destination')
    const result = await fetch(url, { ...init, redirect: 'manual', headers: { Authorization: authorization, ...Object.fromEntries(new Headers(init.headers)) }, signal: AbortSignal.timeout(120000) })
    if (!result.ok) throw new Error(`Factory image registry request failed (${result.status})`)
    return result
  }
  const manifestBytes = await verified(base + 'llll-workspace-manifest.json', factory.files['llll-workspace-manifest.json']!, 100000)
  if ('sha256:' + await digest(manifestBytes) !== factory.manifestDigest) throw new Error('Factory image manifest mismatch')
  const imageManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { config: { digest: string }; layers: { digest: string }[] }
  const blobs = [{ file: 'llll-workspace-config.json', digest: imageManifest.config.digest }, ...factory.layers]
  if (blobs.length > 20 || imageManifest.layers.length !== factory.layers.length) throw new Error('Factory image layer limit exceeded')
  for (const blob of blobs) {
    if (!/^llll-workspace-(?:config\.json|layer-\d+\.tar\.gz)$/u.test(blob.file) || blob.digest !== 'sha256:' + factory.files[blob.file]?.sha256) throw new Error('Factory image layer identity mismatch')
    const expected = factory.files[blob.file]!
    const source = await fetch(base + blob.file, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
    if (!source.ok || !source.body || !Number.isSafeInteger(expected.size) || expected.size > 96000000) throw new Error('Published image layer is unavailable or exceeds upload capacity')
    const hash = streamingSha256.create(); let size = 0
    const checked = source.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      size += chunk.length
      if (size > expected.size) throw new Error('Image layer size mismatch')
      hash.update(chunk); controller.enqueue(chunk)
    } }))
    const start = await registryRequest(registry + '/blobs/uploads/', { method: 'POST' })
    const location = new URL(start.headers.get('location') ?? '', registry).toString()
    const uploaded = await registryRequest(location, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: checked })
    const actual = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
    if (size !== expected.size || actual !== expected.sha256) throw new Error('Image layer checksum mismatch; unverified upload was not committed')
    const target = new URL(uploaded.headers.get('location') ?? location, registry); target.searchParams.set('digest', blob.digest)
    await registryRequest(target.toString(), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } })
  }
  await registryRequest(registry + '/manifests/' + factory.manifestDigest, { method: 'PUT', headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' }, body: manifestBytes })
  const image = `registry.cloudflare.com/${accountId}/${workerName}-factory@${factory.manifestDigest}`
  const current = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
  const names = new Set(['FACTORY_COMPUTE', 'FACTORY_CODE', 'FACTORY_IMAGE', 'FACTORY_POLICY'])
  const bindings: Record<string, unknown>[] = (current.bindings ?? []).filter(binding => !names.has(binding.name)).map(binding => ({ type: 'inherit', name: binding.name }))
  bindings.push({ type: 'durable_object_namespace', name: 'FACTORY_COMPUTE', class_name: 'FactoryComputeDurableObject' },
    { type: 'artifacts', name: 'FACTORY_CODE', namespace }, { type: 'plain_text', name: 'FACTORY_IMAGE', text: image }, { type: 'plain_text', name: 'FACTORY_POLICY', text: JSON.stringify(limits) })
  // Re-upload only the installed, checksum-verified immutable release. Keep original data, assets, secrets and integrations.
  const form = new FormData()
  form.append('metadata', JSON.stringify({ main_module: 'llll-worker.mjs', compatibility_date: release.manifest.compatibilityDate, compatibility_flags: release.manifest.compatibilityFlags,
    bindings, keep_assets: true, containers: [...('containers' in current && Array.isArray(current.containers) ? current.containers.filter((item: { class_name?: string }) => item.class_name !== 'FactoryComputeDurableObject') : []), factoryScriptContainer(workerName, image, size.instance_type)], tags: current.tags, annotations: current.annotations }))
  form.append('llll-worker.mjs', new Blob([release.worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
  await cloudflareApi(accessToken, `/accounts/${accountId}/workers/scripts/${workerName}?excludeScript=true&bindings_inherit=strict`, { method: 'PUT', body: form })
  const deployed = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
  const binding = deployed.bindings?.find(binding => binding.name === 'FACTORY_COMPUTE')
  if (!binding || !('namespace_id' in binding) || !binding.namespace_id) throw new Error('Factory namespace is not ready; retry activation')
  const name = `${workerName}-factory`
  const applications = await cloudflareApi<{ id: string; name: string; scheduling_policy: string; configuration: { image: string; instance_type: string }; durable_objects?: { namespace_id: string } }[]>(accessToken, `/accounts/${accountId}/containers/applications`)
  const application = applications.find(app => app.name === name)
  if (application && application.durable_objects?.namespace_id !== binding.namespace_id) throw new Error('Factory application belongs to a different namespace; inspect it before retrying')
  if (application && (application.configuration.image !== image || application.configuration.instance_type !== size.instance_type || application.scheduling_policy !== 'default')) throw new Error('Existing Factory application image, size or scheduling policy differs from the reviewed release. Pause and reconcile it before activation.')
  if (!application) await cloudflareApi(accessToken, `/accounts/${accountId}/containers/applications`, { method: 'POST', body: JSON.stringify({ name, configuration: { image, instance_type: size.instance_type }, instances: 0, max_instances: 1, scheduling_policy: 'default', durable_objects: { namespace_id: binding.namespace_id } }) })
  return { state: 'provisioning', image, origin: server.origin, message: 'Optional Factory resources provisioned. Return to Server Settings → Repositories and activate Factory once provider resources are ready. No R2 migration or plan upgrade was performed.' }
}
