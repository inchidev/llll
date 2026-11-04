/** Keep the one-time owner credential in a fragment, never a request URL. */
export function readDeploymentClaim(hash: string): string | undefined {
  const claim = new URLSearchParams(hash.replace(/^#/, '')).get('claim')
  return claim && /^[A-Za-z0-9_-]{32,256}$/.test(claim) ? claim : undefined
}
