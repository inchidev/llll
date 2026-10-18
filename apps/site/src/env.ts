export type WebEnv = {
  ASSETS: Fetcher
  DB: D1Database
  AUTH_SECRET: string
  PUBLIC_ORIGIN: string
  ENVIRONMENT?: string
  BUILD_COMMIT?: string
  BUILD_VERSION?: string
  CLOUDFLARE_OAUTH_CLIENT_ID?: string
  GITHUB_TOKEN?: string
  TEST_ALLOW_LOCAL_ORIGINS?: string
}
