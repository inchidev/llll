export const DEFAULT_APP_NAME = 'L4'
export const DEFAULT_APP_TITLE = 'One workspace for humans and agents.'
export const DEFAULT_APP_SUBTITLE = 'Built on your Cloudflare stack.'
export const NEUTRAL_APP_SUBTITLE = 'Built on your own stack.'

type AppBrandingEnv = {
  APP_NAME?: string
  APP_TITLE?: string
  APP_SUBTITLE?: string
  LLLL_RUNTIME?: string
}

function cloudflareBranding(runtime: string | undefined) {
  const value = runtime?.trim().toLowerCase()
  return !value || value === 'cloudflare' || value === 'workers'
}

function normalizedName(value: string | undefined) {
  return value?.trim().replace(/\s+/g, ' ').slice(0, 80) || DEFAULT_APP_NAME
}

function normalizedTitle(value: string | undefined) {
  return value?.trim().replace(/\\n/g, '\n').slice(0, 160) || DEFAULT_APP_TITLE
}

function normalizedSubtitle(value: string | undefined, runtime: string | undefined) {
  const fallback = cloudflareBranding(runtime) ? DEFAULT_APP_SUBTITLE : NEUTRAL_APP_SUBTITLE
  const text = value?.trim().replace(/\s+/g, ' ').slice(0, 240)
  if (!text || text === DEFAULT_APP_SUBTITLE) return fallback
  return text
}

export function readAppBranding(env?: AppBrandingEnv) {
  return {
    appName: normalizedName(env?.APP_NAME),
    appTitle: normalizedTitle(env?.APP_TITLE),
    appSubtitle: normalizedSubtitle(env?.APP_SUBTITLE, env?.LLLL_RUNTIME),
  }
}
