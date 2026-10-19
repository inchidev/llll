import { installerError } from './errors.js'
import type { InstallerAssetsPayload, InstallerRelease, InstallerReleaseManifest, ReleaseAsset } from './types.js'

async function sha256(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function fetchVerifiedAsset(asset: ReleaseAsset, manifestUrl: string, fetcher: typeof fetch) {
  const url = new URL(asset.url, manifestUrl)
  if (url.protocol !== 'https:') installerError(502, 'Release asset URL must use HTTPS')
  const response = await fetcher(url, { redirect: 'follow' })
  if (!response.ok) installerError(502, `L4 release asset is unavailable (${response.status})`)
  const body = await response.arrayBuffer()
  if (body.byteLength !== asset.size || await sha256(body) !== asset.sha256) installerError(502, 'Release asset integrity check failed')
  return body
}

function assertManifest(value: unknown): asserts value is InstallerReleaseManifest {
  const manifest = value as Partial<InstallerReleaseManifest> | null
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.capabilities?.includes('llll-server-schema-v1') || !manifest.version || !manifest.worker || !manifest.assets || !Array.isArray(manifest.durableObjects)) {
    installerError(502, 'L4 release manifest is invalid')
  }
}

export async function loadL4Release(manifestUrl: string, fetcher: typeof fetch = fetch): Promise<InstallerRelease> {
  const response = await fetcher(manifestUrl, { redirect: 'follow' })
  if (!response.ok) installerError(502, `L4 release is unavailable (${response.status})`)
  const manifest = await response.json()
  assertManifest(manifest)
  const [worker, assetsBuffer] = await Promise.all([
    fetchVerifiedAsset(manifest.worker, manifestUrl, fetcher),
    fetchVerifiedAsset(manifest.assets, manifestUrl, fetcher),
  ])
  const assets = JSON.parse(new TextDecoder().decode(assetsBuffer)) as InstallerAssetsPayload
  if (!Array.isArray(assets.assets) || !Array.isArray(assets.migrations)) installerError(502, 'L4 asset bundle is invalid')
  return { manifest, worker, assets }
}

/** The newest published release, read from its manifest. */
export async function latestReleaseVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(releaseManifestUrl(), { redirect: 'follow' })
  if (!response.ok) installerError(502, `L4 release is unavailable (${response.status})`)
  const manifest = await response.json()
  assertManifest(manifest)
  return manifest.version
}

export function releaseManifestUrl(version?: string): string {
  const tag = version ? (version.startsWith('v') ? version : `v${version}`) : ''
  return tag
    ? `https://github.com/inchidev/llll/releases/download/${tag}/llll-cloudflare-manifest.json`
    : 'https://github.com/inchidev/llll/releases/latest/download/llll-cloudflare-manifest.json'
}
