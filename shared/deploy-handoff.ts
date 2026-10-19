/** Keep the one-time owner credential in a fragment, never a request URL. */
export function readDeploymentClaim(hash: string): string | undefined {
  const claim = new URLSearchParams(hash.replace(/^#/, '')).get('claim')
  return claim && /^[A-Za-z0-9_-]{32,256}$/.test(claim) ? claim : undefined
}

/** Consume the private fragment before mirroring Client navigation in Shell. */
export function stripDeploymentClaim(path: string): string {
  const index = path.indexOf('#')
  if (index < 0) return path
  const hash = new URLSearchParams(path.slice(index + 1))
  if (!hash.has('claim')) return path
  hash.delete('claim')
  return path.slice(0, index) + (hash.size ? '#' + hash : '')
}

export function deploymentShellUrl(origin: string, setupUrl?: string): string {
  const claim = setupUrl ? readDeploymentClaim(new URL(setupUrl).hash) : undefined
  const address = `/create?server=${encodeURIComponent(origin)}`
  return claim ? `${address}#${new URLSearchParams({ claim })}` : address
}
