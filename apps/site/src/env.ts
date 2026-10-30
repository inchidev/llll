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
  /** The official bot's token; only the Telegram notifications relay uses it. */
  TELEGRAM_BOT_TOKEN?: string
  /** The official bot's username, for links that open the Telegram Shell. */
  TELEGRAM_BOT_USERNAME?: string
  TEST_ALLOW_LOCAL_ORIGINS?: string
}
