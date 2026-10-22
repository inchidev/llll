import { version as packageVersion } from '../../package.json'

declare const __LLLL_VERSION__: string | undefined

/**
 * The installed release version, baked into the bundle at build time. A
 * published release always bakes its own package version; the installer never
 * sets a version binding. `LLLL_VERSION` remains only as a local fixture
 * override so integration fixtures can impersonate an older release.
 */
export function serverVersion(env?: { LLLL_VERSION?: string }): string {
  if (env?.LLLL_VERSION?.trim()) return env.LLLL_VERSION.trim()
  return typeof __LLLL_VERSION__ === 'string' && __LLLL_VERSION__.trim() ? __LLLL_VERSION__.trim() : packageVersion
}
