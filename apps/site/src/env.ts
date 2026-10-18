export type PortalEnv = {
  ASSETS: Fetcher
  PORTAL_DB: D1Database
  AUTH_SECRET: string
  PUBLIC_ORIGIN: string
  ENVIRONMENT?: string
  BUILD_COMMIT?: string
  CLOUDFLARE_OAUTH_CLIENT_ID?: string
  GITHUB_TOKEN?: string
  TEST_ALLOW_LOCAL_ORIGINS?: string
}
