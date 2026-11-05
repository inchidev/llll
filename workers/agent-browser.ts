import { fileStorage, type FileStorageEnv } from '../shared/file-storage'
import { chromiumBrowser } from './browser-cdp'
import { cloudflareBrowser, cloudflareRestConfigured } from './cloudflare-rest'
import { assertPublicHttpUrl, isPublicIpAddress } from '../shared/public-http'
export { assertPublicHttpUrl } from '../shared/public-http'

const MAX_MARKDOWN = 24_000
const MAX_LINKS = 50
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024


type BrowserBinding = {
  quickAction: (action: 'markdown' | 'screenshot' | 'links', options: { url: string }) => Promise<Response>
}

function serverHostsFrom(env: { PUBLIC_ORIGIN?: string, LLLL_APP_HOSTNAME?: string }): string[] {
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

type DohAnswer = { Answer?: Array<{ type?: number, data?: string }> }

/** Addresses of a hostname, from a resolver outside this network, so a split-horizon name finds nothing. */
async function resolvePublicDns(host: string, fetcher: typeof fetch): Promise<string[]> {
  const answers = await Promise.all([['A', 1], ['AAAA', 28]].map(async ([type, code]) => {
    const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' } })
    if (!response.ok) throw new Error('DNS lookup failed')
    const body = await response.json() as DohAnswer
    // A CNAME chain arrives in the same answer; only the addresses at its end matter.
    return (body.Answer ?? []).filter(answer => answer.type === code && answer.data).map(answer => answer.data!)
  }))
  return answers.flat()
}

/**
 * For the local Chromium path: a name like 127.0.0.1.nip.io looks public until it is resolved.
 * Every address must be public, and a failed lookup refuses. Chromium looks the name up again itself,
 * so DNS rebinding remains: see Browser in docs/self-host/celld.md.
 */
export async function assertPublicDestination(raw: string, serverHosts: string[] = [], fetcher: typeof fetch = fetch): Promise<void> {
  const parsed = assertPublicHttpUrl(raw, serverHosts)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (host.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return
  const addresses = await resolvePublicDns(host, fetcher)
  if (!addresses.length || addresses.some(address => !isPublicIpAddress(address))) {
    throw new Error('That address is not a public website')
  }
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
  PUBLIC_ORIGIN?: string
  LLLL_APP_HOSTNAME?: string
}

export function browserBindingFor(env: BrowserEnv): BrowserBinding | null {
  if (env.BROWSER) return env.BROWSER
  if (cloudflareRestConfigured(env)) return cloudflareBrowser(env)
  const cdpUrl = env.BROWSER_CDP_URL?.trim()
  if (cdpUrl) {
    const hosts = serverHostsFrom(env)
    return chromiumBrowser(cdpUrl, finalUrl => assertPublicHttpUrl(finalUrl, hosts), url => assertPublicDestination(url, hosts))
  }
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
  const parsed = assertPublicHttpUrl(url, serverHostsFrom(env))
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
  const parsed = assertPublicHttpUrl(url, serverHostsFrom(env))
  const response = await (await requireBrowser(env)).quickAction('links', { url: parsed.toString() })
  if (!response.ok) await readError(response)
  const payload = await response.json() as { result?: string[] }
  const links = (payload.result ?? []).filter((link): link is string => typeof link === 'string')
  return { url: parsed.toString(), links: links.slice(0, MAX_LINKS) }
}

export async function captureBrowserScreenshot(
  env: BrowserEnv & FileStorageEnv & { PUBLIC_ORIGIN?: string, LLLL_APP_HOSTNAME?: string },
  url: string,
  objectKey: string,
): Promise<{ url: string, r2Key: string | null, contentType: string, sizeBytes: number }> {
  const parsed = assertPublicHttpUrl(url, serverHostsFrom(env))
  const response = await (await requireBrowser(env)).quickAction('screenshot', { url: parsed.toString() })
  if (!response.ok) await readError(response)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  if (!contentType.startsWith('image/')) throw new Error('Browser screenshot did not return an image')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength) throw new Error('Browser screenshot was empty')
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeded 4 MB')
  let r2Key: string | null = null
  if (env.FILES || (env.DB && env.TICKETS)) {
    await fileStorage(env).put(objectKey, bytes, { httpMetadata: { contentType } })
    r2Key = objectKey
  }
  return { url: parsed.toString(), r2Key, contentType, sizeBytes: bytes.byteLength }
}
