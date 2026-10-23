import {
  refreshCloudflareGrant,
  randomCode,
} from '../../../shared/cloudflare-oauth'
import { installL4 } from '../../../packages/deployment-core/src/installer'
import type { WebEnv } from './env'
import type { DeploymentState } from './session'
import { digest, rememberDeployment } from './session'

/** Releases come from published GitHub tags, never from a pinned env URL.
 * The operator configures no version: the user picks one on `/create` and the
 * web verifies it against that release's own `SHA256SUMS` plus per-module
 * hashes. Published tags and assets are immutable; a repair needs a new version.
 */
export const RELEASE_REPO = 'inchidev/llll'
export const VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/
const ARTIFACT_FILE = 'llll-deployment.json'
const MANIFEST_FILE = 'llll-cloudflare-manifest.json'
type Asset = {
  path: string
  hash: string
  size: number
  contentType: string
  contentBase64: string
}
type Artifact = {
  schemaVersion: number
  version: string
  modules: Record<string, { content: string; sha256: string }>
  assets: Asset[]
  migrations: { server: { name: string; sql: string }[] }
}
export async function cloudflare<T>(
  token: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body instanceof FormData || body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  let data: {
    success: boolean
    result: T
    errors?: { code?: number | string; message?: string }[]
  }
  try {
    data = (await response.json()) as typeof data
  } catch {
    throw Object.assign(
      new Error(
        `Cloudflare could not complete ${method} ${path.split('?')[0]} (${response.status}): unreadable response. Check account permissions and service activation.`,
      ),
      { status: response.status },
    )
  }
  if (!response.ok || !data.success) {
    const detail = (data.errors || [])
      .map((e) => [e.code, e.message].filter(Boolean).join(' '))
      .filter(Boolean)
      .join('; ')
    throw Object.assign(
      new Error(
        `Cloudflare could not complete ${method} ${path.split('?')[0]} (${response.status})${detail ? `: ${detail}` : '. Check account permissions and service activation.'}`,
      ),
      { status: response.status },
    )
  }
  return data.result
}
export type ReleaseInfo = {
  version: string
  name: string
  published_at: string
  notes_url: string
}

function releaseBase(version: string) {
  if (!VERSION_PATTERN.test(version))
    throw new Error('Choose a published release version')
  return `https://github.com/${RELEASE_REPO}/releases/download/${version}`
}

/** Public GitHub feed avoids the REST quota shared by Cloudflare egress IPs. */
async function feedReleases() {
  const xml = new TextDecoder().decode(await downloadBytes(
    `https://github.com/${RELEASE_REPO}/releases.atom`, 524288, 'release feed',
  ))
  const releases = await Promise.all([...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 20).map(async ([, entry]) => {
    const version = entry?.match(/<id>[^<]*\/(v[^<]+)<\/id>/)?.[1]
    if (!version || !VERSION_PATTERN.test(version)) return null
    try {
      const checksums = new TextDecoder().decode(await downloadBytes(
        `${releaseBase(version)}/SHA256SUMS`, 65536, 'release checksums',
      ))
      const assets = [{ name: 'SHA256SUMS' }, ...[...checksums.matchAll(/^[a-f0-9]{64}[ \t]+([^\s]+)$/gm)].map((match) => ({ name: match[1] }))]
      const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
      const title = (entry?.match(/<title>([^<]*)<\/title>/)?.[1] || version)
        .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name] || '').slice(0, 200)
      return { tag_name: version, name: title, published_at: entry?.match(/<updated>([^<]*)<\/updated>/)?.[1] || '', html_url: `https://github.com/${RELEASE_REPO}/releases/tag/${version}`, assets }
    } catch { return null }
  }))
  return releases.filter((release) => release !== null)
}

/** Published (non-draft) releases with deployment artifacts, newest first.
 * A `GITHUB_TOKEN` (any PAT, no scopes needed for public repos) avoids GitHub
 * API rate limits on shared Cloudflare egress IPs. If the public quota is
 * exhausted, use the public feed and require the same deployment assets.
 */
export async function listReleases(token?: string): Promise<ReleaseInfo[]> {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'llll-web',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
    },
  )
  if (!response.ok && ![403, 429].includes(response.status))
    throw new Error(
      `The release list could not be loaded from GitHub (${response.status})`,
    )
  const data = (response.ok ? await response.json() : await feedReleases()) as {
    tag_name?: string
    name?: string
    draft?: boolean
    prerelease?: boolean
    published_at?: string
    html_url?: string
    assets?: { name?: string }[]
  }[]
  const candidates = data
    .filter(
      (release) =>
        !release.draft &&
        typeof release.tag_name === 'string' &&
        VERSION_PATTERN.test(release.tag_name) &&
        (!release.prerelease ||
          /-(?:alpha|beta|rc)\.\d+$/.test(release.tag_name)) &&
        [ARTIFACT_FILE, MANIFEST_FILE, 'SHA256SUMS'].every((name) =>
          release.assets?.some((asset) => asset.name === name),
        ),
    )
    .map((release) => ({
      version: release.tag_name!,
      name: release.name || release.tag_name!,
      published_at: release.published_at || '',
      notes_url: release.html_url || '',
    }))
  const compatible = await Promise.all(
    candidates.map(async (info) => {
      try {
        const response = await fetch(
          `${releaseBase(info.version)}/${MANIFEST_FILE}`,
          { signal: AbortSignal.timeout(15000) },
        )
        if (!response.ok) return null
        const manifest = (await response.json()) as {
          version?: string
          capabilities?: string[]
        }
        return manifest.version === info.version.slice(1) &&
          manifest.capabilities?.includes('llll-server-schema-v1')
          ? info
          : null
      } catch {
        return null
      }
    }),
  )
  return compatible.filter((info): info is ReleaseInfo => Boolean(info))
}

async function downloadBytes(url: string, limit: number, what: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok || !response.body)
    throw new Error(`The release ${what} could not be downloaded`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) {
      await reader.cancel()
      throw new Error(`Release ${what} exceeds the installer size limit`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

async function release(
  version: string,
): Promise<{ artifact: Artifact; manifestUrl: string }> {
  const base = releaseBase(version)
  const sums = new TextDecoder().decode(
    await downloadBytes(base + '/SHA256SUMS', 1024 * 1024, 'checksums'),
  )
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(
      ([, file]) => file === ARTIFACT_FILE || file === `./${ARTIFACT_FILE}`,
    )?.[0]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('The release checksums do not cover the deployment bundle')
  const bytes = await downloadBytes(
    `${base}/${ARTIFACT_FILE}`,
    64 * 1024 * 1024,
    'bundle',
  )
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
  if (hash !== expected) throw new Error('Release checksum did not match')
  const artifact = JSON.parse(new TextDecoder().decode(bytes)) as Artifact
  if (
    artifact.schemaVersion !== 3 ||
    artifact.version !== version.slice(1) ||
    !artifact.modules.server ||
    !Array.isArray(artifact.assets)
  )
    throw new Error('The release bundle does not match the selected version')
  for (const module of Object.values(artifact.modules))
    if ((await digest(module.content)) !== module.sha256)
      throw new Error('Release module checksum did not match')
  return { artifact, manifestUrl: `${base}/${MANIFEST_FILE}` }
}

/** Customer Servers install only a published release, uploaded through this browser's OAuth grant. */
export async function advanceDeployment(
  state: DeploymentState,
  _env: WebEnv,
  save: () => Promise<void>,
) {
  if (
    !state.grant ||
    !state.accountId ||
    !state.version ||
    !state.worker ||
    !state.name ||
    !state.ownerEmail ||
    !state.setupToken
  )
    throw new Error('Start the deployment first')
  if (state.grant.expiresAt < Date.now() + 120000) {
    state.grant = await refreshCloudflareGrant(state.grant)
    await save()
  }
  const serverId = state.serverId || /^llll-([0-9a-f-]{36})$/u.exec(state.worker)?.[1]
  if (!serverId) throw new Error('Start the deployment first with a Server ID')
  state.serverId = serverId
  const token = state.grant.accessToken
  if (state.step === 0) {
    // Verify the published artifact before allocating any Cloudflare resource.
    await release(state.version)
    state.step = 1
    await save()
    return
  }
  if (state.step === 1) {
    const result = await installL4(
      token,
      {
        accountId: state.accountId,
        serverId,
        workerName: state.worker,
        targetVersion: state.version,
        appName: state.name,
        adminEmail: state.ownerEmail,
        allowedEmails: [],
        authMode: 'builtin',
        registrationMode: 'invite_only',
        filesEnabled: true,
        backupBucketName: `llll-${serverId}-backups`,
        customDomainEnabled: false,
        zoneId: '',
        zoneName: '',
        appSubdomain: state.worker,
        mailEnabled: false,
        mailSubdomain: '',
        mailLocalPart: '',
      },
      { verify: false, setupToken: state.setupToken, report: async event => {
        state.progress = [...(state.progress || []).filter(item => item.step !== event.step), event].slice(-20)
        await save()
      } },
    )
    state.origin = result.url
    state.step = 2
    await save()
    return
  }
  if (state.step === 2) {
    const origin = state.origin
    if (!origin) throw new Error('Start the deployment first')
    const check = await fetch(origin + '/.well-known/llll', {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    }).catch(() => null)
    const data = check?.ok
      ? ((await check.json()) as {
          kind: string
          version: string
          origin: string
        })
      : null
    if (
      !data ||
      data.kind !== 'server' ||
      data.origin !== origin ||
      data.version !== state.version.slice(1)
    )
      return
    delete state.verifier
    delete state.state
    state.completed = true
    state.step = 3
    rememberDeployment(state)
    await save()
  }
}
export function deploymentParameters(
  accountId: string,
  name: string,
  version: string,
  ownerEmail: string,
) {
  if (!VERSION_PATTERN.test(version))
    throw new Error('Choose a published release version')
  const serverId = crypto.randomUUID()
  return {
    accountId,
    name,
    version,
    ownerEmail,
    serverId,
    worker: 'llll-' + serverId,
    setupToken: randomCode(),
    step: 0,
  }
}

/** Never retain a grant that requires fresh account consent, or expose raw upstream diagnostics. */
export function deploymentFailure(error: unknown): { message: string; reconnect: boolean } {
  const value = error && typeof error === 'object' ? error as { message?: string; status?: number; statusCode?: number } : {}
  if (/verify.*email|email.*verif/iu.test(value.message || '')) return { message: 'Verify your Cloudflare email, then reconnect Cloudflare and resume this deployment.', reconnect: true }
  if ([401, 403].includes(value.status ?? value.statusCode ?? 0) || /authorization expired|reconnect cloudflare/iu.test(value.message || '')) return { message: 'Cloudflare access needs renewal. Reconnect Cloudflare, approve the requested permissions, then resume this deployment.', reconnect: true }
  if ((value.status ?? value.statusCode) === 429) return { message: 'Cloudflare reached a rate limit. Wait briefly, then resume the same deployment.', reconnect: false }
  return { message: 'Deployment paused. Review the last step and resume the same Server. Reconnect Cloudflare if account access changed.', reconnect: false }
}
