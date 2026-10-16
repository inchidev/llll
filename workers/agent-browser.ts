import { chromiumBrowser } from './browser-cdp'
import { cloudflareBrowser, cloudflareRestConfigured } from './cloudflare-rest'

const MAX_MARKDOWN = 24_000
const MAX_LINKS = 50
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.internal',
])

type BrowserBinding = {
  quickAction: (action: 'markdown' | 'screenshot' | 'links', options: { url: string }) => Promise<Response>
}

function workspaceHostsFrom(env: { PUBLIC_ORIGIN?: string, LLLL_APP_HOSTNAME?: string }): string[] {
  const hosts: string[] = []
  const origin = env.PUBLIC_ORIGIN?.trim()
  if (origin) {
    try { hosts.push(new URL(origin).hostname.toLowerCase()) }
    catch { /* ignore invalid origin */ }
  }
  const hostname = env.LLLL_APP_HOSTNAME?.trim().toLowerCase()
  if (hostname) hosts.push(hostname)
  return [...new Set(hosts.filter(Boolean))]
}

function isIpv4(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
}

function parseIpv4(host: string): number | null {
  const parts = host.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function isPrivateIpv4(host: string): boolean {
  const ip = parseIpv4(host)
  if (ip === null) return true
  const nets: Array<[number, number]> = [
    [0x00000000, 0xff000000],
    [0x0a000000, 0xff000000],
    [0x7f000000, 0xff000000],
    [0xac100000, 0xfff00000],
    [0xc0a80000, 0xffff0000],
    [0xa9fe0000, 0xffff0000],
    [0xe0000000, 0xf0000000],
  ]
  return nets.some(([net, mask]) => ((ip & mask) >>> 0) === net)
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase()
  if (value === '::' || value === '::1') return true
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1]!)
  return false
}

/** Rejects non-public, credentialed, or workspace-origin URLs before Browser Run. */
export function assertPublicHttpUrl(raw: string, workspaceHosts: string[] = []): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Enter a URL')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  }
  catch {
    throw new Error('Enter a valid http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new Error('Enter a valid http or https URL')
  if (
    BLOCKED_HOSTS.has(host)
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    throw new Error('That address is not a public website')
  }
  if (workspaceHosts.some(workspaceHost => host === workspaceHost.toLowerCase())) {
    throw new Error('Agents cannot browse the workspace origin')
  }
  if (isIpv4(host) && isPrivateIpv4(host)) throw new Error('That address is not a public website')
  if (host.includes(':') && isPrivateIpv6(host)) throw new Error('That address is not a public website')
  return parsed
}

function browserError(status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ message?: string }>, error?: string, message?: string }
    const message = parsed.errors?.[0]?.message || parsed.error || parsed.message
    if (message) return new Error(message)
  }
  catch { /* use status */ }
  if (status === 429) return new Error('Browser time or rate limit exceeded. Try again later or upgrade to Workers Paid.')
  return new Error(`Browser request failed (${status})`)
}

type BrowserEnv = {
  BROWSER?: BrowserBinding
  BROWSER_CDP_URL?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
}

export function browserBindingFor(env: BrowserEnv): BrowserBinding | null {
  if (env.BROWSER) return env.BROWSER
  if (cloudflareRestConfigured(env)) return cloudflareBrowser(env)
  const cdpUrl = env.BROWSER_CDP_URL?.trim()
  if (cdpUrl) return chromiumBrowser(cdpUrl)
  return null
}

async function requireBrowser(env: BrowserEnv): Promise<BrowserBinding> {
  const browser = browserBindingFor(env)
  if (!browser) throw new Error('Public page reading is unavailable. Bind Browser Run, set a Cloudflare API token, or set BROWSER_CDP_URL.')
  return browser
}

async function readError(response: Response): Promise<never> {
  throw browserError(response.status, await response.text())
}

export async function readBrowserMarkdown(
  env: BrowserEnv & { PUBLIC_ORIGIN?: string, LLLL_APP_HOSTNAME?: string },
  url: string,
): Promise<{ url: string, markdown: string }> {
  const parsed = assertPublicHttpUrl(url, workspaceHostsFrom(env))
  const response = await (await requireBrowser(env)).quickAction('markdown', { url: parsed.toString() })
  if (!response.ok) await readError(response)
  const payload = await response.json() as { result?: string }
  const markdown = typeof payload.result === 'string' ? payload.result : ''
  if (!markdown.trim()) throw new Error('The page had no readable text')
  return {
    url: parsed.toString(),
    markdown: markdown.length > MAX_MARKDOWN ? `${markdown.slice(0, MAX_MARKDOWN)}\n…truncated` : markdown,
  }
}

export async function listBrowserLinks(
  env: BrowserEnv & { PUBLIC_ORIGIN?: string, LLLL_APP_HOSTNAME?: string },
  url: string,
): Promise<{ url: string, links: string[] }> {
  const parsed = assertPublicHttpUrl(url, workspaceHostsFrom(env))
  const response = await (await requireBrowser(env)).quickAction('links', { url: parsed.toString() })
  if (!response.ok) await readError(response)
  const payload = await response.json() as { result?: string[] }
  const links = (payload.result ?? []).filter((link): link is string => typeof link === 'string')
  return { url: parsed.toString(), links: links.slice(0, MAX_LINKS) }
}

export async function captureBrowserScreenshot(
  env: BrowserEnv & { FILES?: R2Bucket, PUBLIC_ORIGIN?: string, LLLL_APP_HOSTNAME?: string },
  url: string,
  objectKey: string,
): Promise<{ url: string, r2Key: string | null, contentType: string, sizeBytes: number }> {
  const parsed = assertPublicHttpUrl(url, workspaceHostsFrom(env))
  const response = await (await requireBrowser(env)).quickAction('screenshot', { url: parsed.toString() })
  if (!response.ok) await readError(response)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  if (!contentType.startsWith('image/')) throw new Error('Browser screenshot did not return an image')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength) throw new Error('Browser screenshot was empty')
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeded 4 MB')
  let r2Key: string | null = null
  if (env.FILES) {
    await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType } })
    r2Key = objectKey
  }
  return { url: parsed.toString(), r2Key, contentType, sizeBytes: bytes.byteLength }
}
