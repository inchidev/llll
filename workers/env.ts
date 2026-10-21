/// <reference types="@cloudflare/workers-types" />

import { cloudflareRestConfigured } from './cloudflare-rest'

export type Rpc<T> = { fetch: (request: Request) => Promise<Response> } & T

export function asRpc<T>(stub: unknown): Rpc<T> {
  return stub as Rpc<T>
}

export type L4Env = {
  /** Dedicated repository integration, separate from GitHub sign-in. Never exposed to compute. */
  GITHUB_AGENT_APP_ID?: string
  GITHUB_AGENT_APP_PRIVATE_KEY?: string
  /** Isolated Pi executor transport. Never exposed to agents or browser clients. */
  AGENT_RUN_DO?: DurableObjectNamespace
  AGENT_SCHEDULE_DO?: DurableObjectNamespace
  AGENT_COMPUTE?: DurableObjectNamespace
  AGENT_RUNNER_URL?: string
  AGENT_RUNNER_TOKEN?: string
  /** Server address reachable from a VPS agent's private Docker network. */
  AGENT_CALLBACK_ORIGIN?: string
  /** Optional search provider credential; never sent to compute. */
  EXA_API_KEY?: string

  /** Additional origins allowed to embed this Server client. */
  EMBED_ORIGINS?: string
  TELEGRAM_TRUSTED_BOT_ID?: string
  TELEGRAM_BOT_TOKEN?: string
  DB: D1Database
  BACKUPS?: R2Bucket
  BACKUP_BUCKET_NAME?: string
  FILES?: R2Bucket
  TICKETS: KVNamespace
  CHANNEL_DO: DurableObjectNamespace
  SERVER_DO: DurableObjectNamespace
  RATE_LIMIT_DO: DurableObjectNamespace
  NOTIFICATION_DO: DurableObjectNamespace
  AGENT_DO: DurableObjectNamespace
  AGENT_THINK: DurableObjectNamespace
  AI?: Ai
  /** OpenAI-compatible chat completions base, including `/v1` when the server expects it. */
  AI_BASE_URL?: string
  /** Secret. Sent as a bearer token to `AI_BASE_URL`. */
  AI_API_KEY?: string
  /** Model id for the OpenAI-compatible provider. */
  AI_MODEL?: string
  BROWSER?: {
    quickAction: (action: 'markdown' | 'screenshot' | 'links', options: { url: string }) => Promise<Response>
  }
  /** Chromium DevTools endpoint, `http://127.0.0.1:9222` or a `ws://` browser socket. */
  BROWSER_CDP_URL?: string
  EMAIL?: SendEmail
  MAIL_EMAIL?: SendEmail
  /** Cloudflare service binding, or an http(s) URL for the same JSON send protocol. */
  MAIL_GATEWAY?: Fetcher | string
  MAIL_GATEWAY_URL?: string
  MAIL_GATEWAY_TOKEN?: string
  /** HTTP gateway that relays outbound mail over SMTP. Inbound mail is a separate webhook. */
  SMTP_GATEWAY_URL?: string
  SMTP_GATEWAY_TOKEN?: string
  /**
   * Shared secret for `POST /api/email/inbound`. At least 32 characters.
   * The Email Routing bridge signs with the same value.
   */
  INBOUND_EMAIL_SECRET?: string
  /** HTTP Basic password for `POST /api/email/inbound/postmark`. At least 32 characters. */
  POSTMARK_INBOUND_SECRET?: string
  /** Mailgun HTTP webhook signing key for `POST /api/email/inbound/mailgun`. At least 32 characters. */
  MAILGUN_WEBHOOK_SIGNING_KEY?: string
  /** Amazon SNS topic ARN allowed to call `POST /api/email/inbound/ses`. */
  SES_SNS_TOPIC_ARN?: string
  /**
   * `cloudflare` or `workers` keeps Cloudflare-network features.
   * Any other value, including `celld`, turns them off.
   */
  LLLL_RUNTIME?: string
  LLLL_EMAIL_DOMAINS?: string
  ASSETS?: { fetch: (request: Request) => Promise<Response> }
  REALTIMEKIT_ACCOUNT_ID?: string
  REALTIMEKIT_APP_ID?: string
  REALTIMEKIT_API_TOKEN?: string
  REALTIMEKIT_PRESET_HOST?: string
  REALTIMEKIT_PRESET_PARTICIPANT?: string
  AUTH_SECRET?: string
  AUTH_MODE?: string
  CF_ACCESS_ISS?: string
  CF_ACCESS_AUD?: string
  PUBLIC_ORIGIN?: string
  TWITTER_CLIENT_ID?: string
  TWITTER_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  LINKEDIN_CLIENT_ID?: string
  LINKEDIN_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  TELEGRAM_CLIENT_ID?: string
  TELEGRAM_CLIENT_SECRET?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
  EMAIL_FROM?: string
  EMAIL_FROM_NAME?: string
  MAIL_APP_HOSTNAME?: string
  MAIL_DEFAULT_LOCAL_PART?: string
  AUTH_REGISTRATION_MODE?: string
  VAPID_SUBJECT?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  APP_NAME?: string
  APP_TITLE?: string
  APP_SUBTITLE?: string
  ADMIN_EMAIL?: string
  SETUP_TOKEN?: string
  ADMIN_PASSWORD?: string
  ADMIN_NAME?: string
  ADMIN_HANDLE?: string
  ADMIN_SERVER?: string
  AGENT_MODEL?: string
  LLLL_ACCOUNT_ID?: string
  LLLL_WORKER_NAME?: string
  LLLL_CUSTOM_DOMAIN?: string
  LLLL_ZONE_ID?: string
  LLLL_ZONE_NAME?: string
  LLLL_APP_SUBDOMAIN?: string
  LLLL_SERVER_MARKER?: string
  LLLL_VERSION?: string
  /** Secret, limited to starting this Server's Git-connected Build. */
  LLLL_UPDATE_HOOK?: string
  LLLL_APP_HOSTNAME?: string
  /** Cloudflare account id used to call Workers AI, Browser Run, Email Sending, and RealtimeKit over REST. */
  CLOUDFLARE_ACCOUNT_ID?: string
  /** Secret. Account API token for `CLOUDFLARE_ACCOUNT_ID`. Not `LLLL_ACCOUNT_ID`. */
  CLOUDFLARE_API_TOKEN?: string
}

export type AiProviderName = 'workers-ai' | 'workers-ai-rest' | 'openai-compatible' | null
export type BrowserProviderName = 'workers' | 'cloudflare-rest' | 'cdp' | null
export type CallsProviderName = 'realtimekit' | 'realtimekit-rest' | null

export function aiProvider(env: L4Env): AiProviderName {
  if (env.AI) return 'workers-ai'
  if (cloudflareRestConfigured(env)) return 'workers-ai-rest'
  if (env.AI_BASE_URL?.trim() && env.AI_API_KEY?.trim() && env.AI_MODEL?.trim()) return 'openai-compatible'
  return null
}

export function agentBrowserConfigured(env: L4Env): boolean {
  return browserProvider(env) !== null
}

export function browserProvider(env: L4Env): BrowserProviderName {
  if (env.BROWSER) return 'workers'
  if (cloudflareRestConfigured(env)) return 'cloudflare-rest'
  if (env.BROWSER_CDP_URL?.trim()) return 'cdp'
  return null
}

export function agentRuntimeConfigured(env: L4Env): boolean {
  return Boolean(env.AGENT_DO && aiProvider(env))
}

/** RealtimeKit calls and Email Routing need Cloudflare's network. */
export function cloudflareNetwork(env: L4Env): boolean {
  const runtime = env.LLLL_RUNTIME?.trim().toLowerCase()
  if (runtime === 'cloudflare' || runtime === 'workers') return true
  if (runtime) return false
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/celld/i.test(ua)) return false
  return true
}

/**
 * Calls on Cloudflare's network use the existing RealtimeKit connection.
 * Off that network, the shared Cloudflare API token can drive RealtimeKit's REST API.
 */
export function callsProvider(env: L4Env): CallsProviderName {
  if (cloudflareNetwork(env)) return 'realtimekit'
  if (cloudflareRestConfigured(env)) return 'realtimekit-rest'
  return null
}

export const DEFAULT_WORKERS_MODEL = '@cf/moonshotai/kimi-k2.7-code'

/** Profile ids that start with `@cf/` are Workers AI ids and are not sent to an OpenAI-compatible endpoint. */
export function resolveAgentModelId(env: L4Env, profileModel?: string | null): string {
  const profile = profileModel?.trim() || ''
  if (aiProvider(env) === 'openai-compatible') {
    if (profile && !profile.startsWith('@cf/')) return profile
    return env.AI_MODEL!.trim()
  }
  return profile || env.AGENT_MODEL?.trim() || DEFAULT_WORKERS_MODEL
}

export function piRuntimeConfigured(env: L4Env): boolean {
  return Boolean(env.AGENT_RUN_DO && env.FILES && (env.AGENT_COMPUTE || (env.AGENT_RUNNER_URL && env.AGENT_RUNNER_TOKEN)))
}
