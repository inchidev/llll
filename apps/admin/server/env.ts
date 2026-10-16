/** Bindings of a L4 Admin Worker. admin-core creates them; see `adminBindings`. */
export type AdminEnv = {
  ADMIN_DB: D1Database
  ASSETS?: Fetcher
  COORDINATOR: DurableObjectNamespace
  /** Encrypts stored credentials and signs nothing else. */
  ADMIN_SECRET: string
  ADMIN_WORKER_NAME?: string
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_OAUTH_CLIENT_ID?: string
  /** Handed over once at deploy; the Admin moves it into its own storage and rotates it. */
  CLOUDFLARE_OAUTH_REFRESH_TOKEN?: string
  /** One-time owner claim, or a recovery claim set later with `wrangler secret put`. */
  ADMIN_CLAIM_TOKEN?: string
  LLLL_VERSION?: string
  LLLL_DIRECTORY_ENDPOINT?: string
  LLLL_DIRECTORY_ID?: string
  LLLL_DIRECTORY_TOKEN?: string
  /** Testing only: read releases from another manifest. */
  LLLL_RELEASE_MANIFEST?: string
}
