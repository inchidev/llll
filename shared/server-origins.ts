export type ServerOrigin = {
  origin: string
  hostname: string
  primary: boolean
}

/** An origin is a scheme, host and optional port only. Paths and credentials are rejected. */
export function normalizeServerOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  }
  catch {
    throw new Error('Enter an absolute HTTP or HTTPS origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Enter an HTTP or HTTPS origin without a path, query or credentials')
  }
  return url.origin
}

export function serverOriginHostname(origin: string): string {
  return new URL(origin).hostname.toLowerCase()
}

/** `LLLL_ORIGINS` is a comma- or whitespace-separated fallback for environments without D1 management. */
export function parseServerOriginList(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const origins: string[] = []
  for (const candidate of value.split(/[\s,]+/u)) {
    if (!candidate) continue
    try {
      const origin = normalizeServerOrigin(candidate)
      if (!origins.includes(origin)) origins.push(origin)
    }
    catch {
      // A malformed optional alias must not disable the primary origin.
    }
  }
  return origins
}

export function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, '')
  if (
    hostname.length < 1
    || hostname.length > 253
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)
    || hostname.includes('..')
  ) {
    throw new Error('Enter a valid DNS hostname')
  }
  return hostname
}
