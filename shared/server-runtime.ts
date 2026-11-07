/**
 * Where a Server runs, from `LLLL_RUNTIME`:
 * - `cloudflare` (or unset, or `workers`): a Cloudflare account of its own, installed from llll.gg/create, which
 *   manages its domains and updates through the installer's grant;
 * - `celld`: a VPS, where the operator's CLI manages it;
 * - `cloud`: L4 Cloud, in a dispatch namespace of ours, where the control plane manages it and the Server holds no
 *   account at all (ADR 0008).
 */
export type ServerRuntime = 'cloudflare' | 'celld' | 'cloud'

export function serverRuntime(env?: { LLLL_RUNTIME?: string }): ServerRuntime {
  const value = env?.LLLL_RUNTIME?.trim().toLowerCase()
  if (value === 'celld' || value === 'cloud') return value
  return 'cloudflare'
}

/** The Server runs on a VPS, from a Docker image. */
export const isCelld = (env?: { LLLL_RUNTIME?: string }) => serverRuntime(env) === 'celld'

/** The Server runs on L4 Cloud. */
export const isCloudHosted = (env?: { LLLL_RUNTIME?: string }) => serverRuntime(env) === 'cloud'

/** Someone other than the Server manages its infrastructure: its origin is fixed and it never installs or updates itself. */
export const isOperatorManaged = (env?: { LLLL_RUNTIME?: string }) => serverRuntime(env) !== 'cloudflare'
