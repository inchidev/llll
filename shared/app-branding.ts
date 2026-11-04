export const DEFAULT_APP_NAME = 'L4'
export const DEFAULT_APP_TITLE = 'One workspace for humans and agents.'
export const DEFAULT_APP_SUBTITLE = 'Built on your Cloudflare stack.'
export const NEUTRAL_APP_SUBTITLE = 'Built on your own stack.'

type AppBrandingEnv = {
  LLLL_RUNTIME?: string
}

function cloudflareBranding(runtime: string | undefined) {
  const value = runtime?.trim().toLowerCase()
  return !value || value === 'cloudflare' || value === 'workers'
}

function normalizedSubtitle(value: string | undefined, runtime: string | undefined) {
  const fallback = cloudflareBranding(runtime) ? DEFAULT_APP_SUBTITLE : NEUTRAL_APP_SUBTITLE
  const text = value?.trim().replace(/\s+/g, ' ').slice(0, 240)
  if (!text || text === DEFAULT_APP_SUBTITLE) return fallback
  return text
}

/** Branding lives in D1 (the Server name) and product constants; env is gone. */
export function readAppBranding(env?: AppBrandingEnv) {
  return {
    appName: DEFAULT_APP_NAME,
    appTitle: DEFAULT_APP_TITLE,
    appSubtitle: normalizedSubtitle(undefined, env?.LLLL_RUNTIME),
  }
}
