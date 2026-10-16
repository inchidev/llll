export type PortalEnv = {
  ASSETS: Fetcher
  PORTAL_DB: D1Database
  AUTH_SECRET: string
  PUBLIC_ORIGIN: string
  CLOUDFLARE_OAUTH_CLIENT_ID?: string
  DEPLOYMENT_RELEASE_URL?: string
  DEPLOYMENT_RELEASE_SHA256?: string
  TEST_ALLOW_LOCAL_ORIGINS?: string
}
