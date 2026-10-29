import { installerError } from './errors.js'
import type { InstallerAssetsPayload, InstallerRelease, InstallerReleaseManifest, ReleaseAsset } from './types.js'

async function sha256(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const transient = [408, 429, 500, 502, 503, 504]
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/**
 * GitHub rate-limits release downloads from shared Cloudflare egress, so reads
 * retry with backoff. A tagged release is immutable and every asset is checked
 * against its SHA-256, so its responses may also be cached at the edge; the
 * moving `latest` manifest is never cached.
 */
export async function releaseFetch(url: string | URL, fetcher: typeof fetch = fetch, attempts = 4): Promise<Response> {
  const tagged = !String(url).includes('/releases/latest/')
  const init = { redirect: 'follow', ...(tagged ? { cf: { cacheEverything: true, cacheTtl: 86400 } } : {}) } as RequestInit
  for (let attempt = 1; ; attempt++) {
    const response = await fetcher(url, init)
    if (response.ok || !transient.includes(response.status) || attempt >= attempts) return response
    const header = Number(response.headers.get('retry-after'))
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** (attempt - 1)
    await response.body?.cancel()
    // Never hold an installer step longer than GitHub's short throttling windows.
    if (wait > 30_000) return new Response(null, { status: response.status })
    await sleep(Math.round(wait * (1 + Math.random() * 0.25)))
  }
}

async function fetchVerifiedAsset(asset: ReleaseAsset, manifestUrl: string, fetcher: typeof fetch) {
  const url = new URL(asset.url, manifestUrl)
  if (url.protocol !== 'https:') installerError(502, 'Release asset URL must use HTTPS')
  const response = await releaseFetch(url, fetcher)
  if (!response.ok) installerError(502, `L4 release asset is unavailable (${response.status})`)
  const body = await response.arrayBuffer()
  if (body.byteLength !== asset.size || await sha256(body) !== asset.sha256) installerError(502, 'Release asset integrity check failed')
  return body
}

function assertManifest(value: unknown): asserts value is InstallerReleaseManifest {
  const manifest = value as Partial<InstallerReleaseManifest> | null
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.capabilities?.includes('llll-server-schema-v2') || !manifest.version || !manifest.worker || !manifest.assets || !Array.isArray(manifest.durableObjects)) {
    installerError(502, 'L4 release manifest is invalid')
  }
}

export async function loadL4Release(manifestUrl: string, fetcher: typeof fetch = fetch): Promise<InstallerRelease> {
  const response = await releaseFetch(manifestUrl, fetcher)
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
  const response = await releaseFetch(releaseManifestUrl(), fetcher)
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

/**
 * Check that a tag publishes a Server manifest whose bytes match the
 * release's SHA256SUMS and that it stays on this schema line. Module and
 * asset hashes are checked again when the release is loaded for upload.
 */
export async function verifyPublishedRelease(version: string, fetcher: typeof fetch = fetch): Promise<void> {
  const target = version.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) installerError(400, 'The selected release version is invalid')
  const base = `https://github.com/inchidev/llll/releases/download/v${target}`
  const sums = await releaseFetch(`${base}/SHA256SUMS`, fetcher)
  if (!sums.ok) installerError(502, `L4 v${target} is not published (${sums.status})`)
  const text = await sums.text()
  const expected = text.length <= 65536 ? text.match(/^([a-f0-9]{64})[ \t]+llll-cloudflare-manifest\.json$/m)?.[1] : undefined
  if (!expected) installerError(502, 'The release does not publish a Server manifest')
  const response = await releaseFetch(`${base}/llll-cloudflare-manifest.json`, fetcher)
  if (!response.ok) installerError(502, `The L4 v${target} manifest is unavailable (${response.status})`)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > 1024 * 1024 || await sha256(bytes) !== expected) installerError(502, 'The release manifest checksum did not match')
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { version?: string; capabilities?: string[] }
  if (manifest.version !== target || !manifest.capabilities?.includes('llll-server-schema-v2')) installerError(409, 'The release cannot update this Server')
}
