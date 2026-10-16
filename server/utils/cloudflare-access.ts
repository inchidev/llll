import type { H3Event } from 'h3'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { AuthMode } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { cf } from './cf'

export type CloudflareAccessIdentity = {
  id: string
  email: string
  name: string
}

export type AccessConfig = {
  issuer: string
  audience: string
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function authMode(env: Pick<L4Env, 'AUTH_MODE'>): AuthMode {
  return env.AUTH_MODE?.trim().toLowerCase() === 'access' ? 'access' : 'builtin'
}

export function readCloudflareAccessConfig(env: Pick<L4Env, 'CF_ACCESS_ISS' | 'CF_ACCESS_AUD'>): AccessConfig {
  const issuer = env.CF_ACCESS_ISS?.trim().replace(/\/$/, '') || ''
  const audience = env.CF_ACCESS_AUD?.trim() || ''
  let parsed: URL | null = null
  try {
    parsed = new URL(issuer)
  }
  catch {
    // Report one deployment-facing error below.
  }
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.cloudflareaccess.com') || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || !audience) {
    throw new Error('CF_ACCESS_ISS and CF_ACCESS_AUD are required for Access authentication')
  }
  return { issuer: parsed.origin, audience }
}

async function identityId(issuer: string, subject: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${issuer}\n${subject}`))
  return `access_${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 40)}`
}

export async function cloudflareAccessIdentity(event: H3Event): Promise<CloudflareAccessIdentity | null> {
  const token = getHeader(event, 'cf-access-jwt-assertion')?.trim()
  if (!token) return null
  const { env } = cf(event)
  const config = readCloudflareAccessConfig(env)
  let remote = jwks.get(config.issuer)
  if (!remote) {
    remote = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`))
    jwks.set(config.issuer, remote)
  }
  return verifyCloudflareAccessToken(token, config, remote)
}

export async function verifyCloudflareAccessToken(
  token: string,
  config: AccessConfig,
  keySet: JWTVerifyGetKey,
): Promise<CloudflareAccessIdentity | null> {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: config.issuer,
    audience: config.audience,
  })
  const subject = typeof payload.sub === 'string' ? payload.sub : ''
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!subject || !email || !email.includes('@')) return null
  const name = typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim().slice(0, 80)
    : (email.split('@')[0] || 'member').slice(0, 80)
  return { id: await identityId(config.issuer, subject), email, name }
}
