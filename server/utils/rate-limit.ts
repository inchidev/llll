import type { H3Event } from 'h3'
import { cloudflareNetwork } from '../../workers/env'
import { asRpc, cf, fail } from './cf'

/**
 * The client address for abuse limits. Cloudflare's edge sets CF-Connecting-IP and
 * strips client copies; a self-hosted proxy (Caddy, Traefik) passes a client-sent copy
 * through untouched, so off Cloudflare only the address the nearest proxy appended to
 * X-Forwarded-For counts.
 */
export function clientIp(event: H3Event): string {
  const { env } = cf(event)
  if (cloudflareNetwork(env)) return getHeader(event, 'cf-connecting-ip')?.trim() || 'unknown'
  const forwarded = getHeader(event, 'x-forwarded-for')?.split(',').map(part => part.trim()).filter(Boolean)
  return forwarded?.at(-1) || getRequestIP(event) || 'unknown'
}

export type RateLimitRule = { key: string, limit: number, windowMs: number }

/**
 * Counts one attempt against every rule and refuses when any is exhausted. A limiter
 * outage refuses too: credential endpoints must not become unlimited. Only a runtime
 * without the Durable Object binding at all (plain `nuxt dev`) skips the check.
 */
export async function requireRateLimit(event: H3Event, rules: RateLimitRule[], message: string) {
  const { env } = cf(event)
  if (!env.RATE_LIMIT_DO) return
  let allowed: boolean[]
  try {
    allowed = await Promise.all(rules.map(rule => asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(rule.key)).take(rule.limit, rule.windowMs)))
  }
  catch {
    fail(503, 'rate_limit_unavailable', 'Sign-in protection is temporarily unavailable. Try again in a moment.')
  }
  if (allowed.some(ok => !ok)) fail(429, 'rate_limited', message)
}
