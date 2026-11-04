// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { createAuth } from '../../server/utils/better-auth'
import { hidePlaceholderEmails, placeholderEmail } from '../../server/utils/account-identity'
import type { AuthRuntimeConfig } from '../../server/utils/auth-config'
import type { L4Env } from '../../workers/env'

const harness = vi.hoisted(() => ({
  auth: null as unknown,
  env: null as unknown,
  hashes: 0,
  limits: [] as string[],
}))

vi.mock('../../server/utils/better-auth', async (original) => {
  const actual = await original<typeof import('../../server/utils/better-auth')>()
  return { ...actual, authFromEvent: async () => harness.auth }
})
vi.mock('../../server/utils/cf', async (original) => {
  const actual = await original<typeof import('../../server/utils/cf')>()
  return { ...actual, cf: () => ({ env: harness.env, request: undefined, waitUntil: () => undefined }) }
})
vi.mock('../../server/utils/auth', () => ({
  ensureDomainUser: async () => ({ id: 'row' }),
  sessionUser: async (_event: unknown, _row: unknown, account: unknown) => account,
}))
vi.mock('../../server/utils/rate-limit', () => ({
  clientIp: () => '203.0.113.1',
  requireRateLimit: async (_event: unknown, rules: { key: string }[]) => { harness.limits.push(...rules.map(rule => rule.key)) },
}))
vi.mock('../../server/utils/password', async (original) => {
  const actual = await original<typeof import('../../server/utils/password')>()
  return { ...actual, hashPassword: async (password: string) => { harness.hashes += 1; return actual.hashPassword(password) } }
})

const origin = 'https://chat.example.com'
const PASSWORD = 'correct horse battery'

const config = (over: { password?: boolean, mail?: boolean } = {}): AuthRuntimeConfig => ({
  mode: 'builtin', registrationMode: 'invite_only',
  enabled: { password: over.password ?? true, github: false, google: false, linkedin: false, twitter: false, turnstile: false },
  credentials: {},
  email: { binding: Boolean(over.mail), from: over.mail ? 'server@example.com' : null, fromName: null, senderManagedByDeployment: false, verificationReady: Boolean(over.mail) },
})

class HttpFailure extends Error {
  constructor(readonly statusCode: number, readonly data: unknown) { super(`HTTP ${statusCode}`) }
}
const cookies: string[] = []
vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler)
vi.stubGlobal('createError', ({ statusCode, data }: { statusCode: number, data?: unknown }) => new HttpFailure(statusCode, data))
vi.stubGlobal('toWebRequest', (event: { request: Request }) => event.request)
vi.stubGlobal('readBody', async (event: { request: Request }) => event.request.clone().json())
vi.stubGlobal('appendResponseHeader', (_event: unknown, _name: string, value: string) => { cookies.push(value) })

let sqlite: DatabaseSync
let env: L4Env

async function start(over: { password?: boolean, mail?: boolean } = {}) {
  harness.auth = await createAuth(env, origin, undefined, config(over))
  return harness.auth as Awaited<ReturnType<typeof createAuth>>
}
const signUp = async (auth: Awaited<ReturnType<typeof createAuth>>, username: string, id = crypto.randomUUID()) => {
  const body = { name: username, email: placeholderEmail(id), password: PASSWORD, username }
  return auth.api.signUpEmail({ headers: new Headers(), body })
}
const row = (username: string) => sqlite.prepare('SELECT * FROM auth_users WHERE username = ?').get(username) as Record<string, unknown> | undefined
const accounts = () => (sqlite.prepare('SELECT count(*) AS n FROM auth_users').get() as { n: number }).n
const sessions = () => (sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get() as { n: number }).n

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  env = { DB: d1(sqlite), PUBLIC_ORIGIN: origin, AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters' } as L4Env
  harness.env = env
  harness.hashes = 0
  harness.limits = []
  cookies.length = 0
})

describe('the username plugin with our rules', () => {
  it('stores the username lowercase, shows what was typed, and keeps <id>@no-email.invalid', async () => {
    const auth = await start()
    const id = crypto.randomUUID()
    await signUp(auth, 'Ada.Lovelace', id)
    expect(row('ada.lovelace')).toMatchObject({ id, email: placeholderEmail(id), email_verified: 0, display_username: 'Ada.Lovelace' })
  })

  it('refuses a name another Account holds in any case, and one breaking our pattern or length', async () => {
    const auth = await start()
    await signUp(auth, 'ada')
    await expect(signUp(auth, 'ADA')).rejects.toMatchObject({ body: { code: 'USERNAME_IS_ALREADY_TAKEN' } })
    for (const bad of ['ab', 'a'.repeat(33), '.ada', 'ada-', 'has space', 'ada@example.com', 'адa']) {
      await expect(signUp(auth, bad), bad).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(accounts()).toBe(1)
  })

  it('signs in an Account with no email in any case, whether or not this Server has mail', async () => {
    for (const mail of [false, true]) {
      const auth = await start({ mail })
      const name = mail ? 'with-mail' : 'no-mail'
      await signUp(auth, name.toUpperCase())
      const signedIn = await auth.api.signInUsername({ headers: new Headers(), body: { username: name, password: PASSWORD } })
      expect(signedIn?.user).toMatchObject({ username: name, displayUsername: name.toUpperCase(), emailVerified: false })
      expect((await auth.$context).options.emailAndPassword?.requireEmailVerification).toBe(false)
    }
  })

  it('accepts passwords up to the 200 characters our routes allow', async () => {
    const auth = await start()
    const long = 'x'.repeat(200)
    await auth.api.signUpEmail({ headers: new Headers(), body: { name: 'long', email: placeholderEmail('long'), password: long, username: 'long' } as never })
    expect((await auth.api.signInUsername({ headers: new Headers(), body: { username: 'long', password: long } }))?.user).toBeTruthy()
  })

  it('changes a username through the plugin hook, refusing a name someone else holds', async () => {
    const auth = await start()
    await signUp(auth, 'ada')
    await signUp(auth, 'grace')
    const { internalAdapter } = await auth.$context
    const id = row('grace')!.id as string
    await expect(internalAdapter.updateUser(id, { username: 'ADA' })).rejects.toMatchObject({ body: { code: 'USERNAME_IS_ALREADY_TAKEN' } })
    await internalAdapter.updateUser(id, { username: 'Hopper', displayUsername: 'Hopper' })
    expect(row('hopper')).toMatchObject({ id, display_username: 'Hopper' })
    await internalAdapter.updateUser(id, { displayUsername: 'HOPPER' })
    expect(row('hopper')).toMatchObject({ display_username: 'HOPPER' })
  })
})

describe('Better Auth paths reached directly', () => {
  const event = (path: string, body: unknown = {}, headers: HeadersInit = {}) => ({
    path,
    request: new Request(`${origin}${path}`, {
      method: body === null ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    }),
  })
  const send = async (target: ReturnType<typeof event>) => {
    const { default: handler } = await import('../../server/api/auth/[...all]')
    return (handler as unknown as (value: unknown) => Promise<Response>)(target).catch((error: unknown) => {
      if (error instanceof HttpFailure) return new Response(null, { status: error.statusCode })
      throw error
    })
  }
  const credentials = { username: 'ada', password: PASSWORD, email: 'stranger@example.com', name: 'Stranger' }

  it.each([
    'sign-in/username', 'sign-in/email', 'sign-up/email', 'sign-in/social',
    'is-username-available', 'update-user', 'send-verification-email', 'change-email', 'request-password-reset',
  ])('closes %s, however the path is spelled', async (name) => {
    const auth = await start()
    await signUp(auth, 'ada')
    const before = sessions()
    for (const path of [
      `/api/auth/${name}`, `/api/auth/${name}/`, `/api/auth/${name}?a=1`, `/api/auth/x/../${name}`, `/api/auth/x/%2e%2e/${name}`,
      `/api/auth/./${name}`, `/api/auth//${name}`, `/api/auth/${name.toUpperCase()}`, `/api/auth/${name.replace(/.$/u, char => `%${char.charCodeAt(0).toString(16)}`)}`,
    ]) {
      const response = await send(event(path, credentials))
      expect(response.status, path).toBe(404)
      expect(response.headers.getSetCookie(), path).toEqual([])
    }
    expect(accounts()).toBe(1)
    expect(sessions()).toBe(before)
  })

  it('cannot create an Account or change a username over HTTP, though sign-up is on for our route', async () => {
    const auth = await start()
    const signedUp = await auth.api.signUpEmail({ headers: new Headers(), body: { name: 'ada', email: placeholderEmail('ada-id'), password: PASSWORD, username: 'ada' } as never, asResponse: true })
    const cookie = signedUp.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    expect((await send(event('/api/auth/sign-up/email', { ...credentials, username: 'stranger' }))).status).toBe(404)
    expect((await send(event('/api/auth/update-user', { username: 'renamed' }, { cookie }))).status).toBe(404)
    expect(accounts()).toBe(1)
    expect(row('renamed')).toBeUndefined()
  })

  it('still serves the rest, and hides the placeholder there', async () => {
    const auth = await start()
    const id = crypto.randomUUID()
    const signedUp = await auth.api.signUpEmail({ headers: new Headers(), body: { name: 'ada', email: placeholderEmail(id), password: PASSWORD, username: 'ada' } as never, asResponse: true })
    const cookie = signedUp.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const response = await send(event('/api/auth/get-session', null, { cookie }))
    expect(response.status).toBe(200)
    const body = await response.json() as { user: { id: string, email: string | null, username: string, displayUsername: string } }
    expect(body.user).toMatchObject({ id, email: null, username: 'ada', displayUsername: 'ada' })
  })

  it('hides the placeholder from what the plugin returns', async () => {
    const auth = await start()
    await signUp(auth, 'ada')
    const raw = await auth.api.signInUsername({ headers: new Headers(), body: { username: 'ada', password: PASSWORD }, asResponse: true })
    expect(await raw.clone().text()).toContain('@no-email.invalid')
    const scrubbed = await hidePlaceholderEmails(raw)
    expect(await scrubbed.text()).not.toContain('@no-email.invalid')
  })
})

describe('POST /api/auth/login', () => {
  const attempt = async (login: string, password = PASSWORD) => {
    const { default: handler } = await import('../../server/api/auth/login.post')
    cookies.length = 0
    const target = { request: new Request(`${origin}/api/auth/login`, { method: 'POST', body: JSON.stringify({ login, password }) }), headers: new Headers() }
    return (handler as unknown as (value: unknown) => Promise<{ user: Record<string, unknown> }>)(target)
      .then(result => ({ status: 200, user: result.user, data: undefined as unknown }))
      .catch((error: HttpFailure) => ({ status: error.statusCode, user: undefined, data: error.data }))
  }
  const verifyEmail = (username: string, email: string) => sqlite.prepare('UPDATE auth_users SET email = ?, email_verified = 1 WHERE username = ?').run(email, username)

  it('signs in by username in any case and returns no placeholder', async () => {
    await signUp(await start(), 'Ada')
    const result = await attempt('ADA')
    expect(result.status).toBe(200)
    expect(result.user).toMatchObject({ username: 'ada', displayUsername: 'Ada', email: null })
    expect(cookies.length).toBeGreaterThan(0)
  })

  it('signs in by an email verified on the Account, and shares its budget with the username', async () => {
    await signUp(await start(), 'ada')
    verifyEmail('ada', 'ada@example.com')
    expect((await attempt('ADA@example.com')).user).toMatchObject({ username: 'ada', email: 'ada@example.com' })
    expect(harness.limits).toContain('account:ada@example.com:login')
    expect(harness.limits).toContain('account:ada:login')
    harness.limits = []
    await attempt('ada')
    expect(harness.limits).toContain('account:ada:login')
  })

  it('refuses unverified, pending and placeholder addresses exactly like a wrong password', async () => {
    const auth = await start()
    const id = crypto.randomUUID()
    await signUp(auth, 'ada', id)
    await signUp(auth, 'grace')
    sqlite.prepare('UPDATE auth_users SET email = ?, email_verified = 0 WHERE username = ?').run('unverified@example.com', 'grace')
    sqlite.prepare('UPDATE auth_users SET pending_email = ? WHERE username = ?').run('claimed@example.com', 'ada')
    const wrong = await attempt('ada', 'not-the-password')
    expect(wrong.status).toBe(401)
    for (const login of ['unverified@example.com', 'claimed@example.com', placeholderEmail(id), 'nobody', 'nobody@example.com', 'a', 'has space', 'x'.repeat(254)]) {
      const refused = await attempt(login)
      expect(refused, login).toEqual(wrong)
    }
  })

  it('spends one hash on an unknown login and on an Account with no password', async () => {
    const auth = await start()
    await signUp(auth, 'ada')
    sqlite.exec(`INSERT INTO auth_users (id, name, email, email_verified, username) VALUES ('social', 'Social', 'social@example.com', 1, 'social')`)
    for (const login of ['nobody', 'nobody@example.com', 'social', 'social@example.com', 'has space']) {
      // The plugin hashes through Better Auth's own option, which calls the mocked helper.
      harness.hashes = 0
      expect((await attempt(login)).status, login).toBe(401)
      expect(harness.hashes, login).toBe(1)
    }
  })

  it('keeps the owner switch for passwords: the plugin alone would ignore it', async () => {
    await signUp(await start(), 'ada')
    const before = sessions()
    await start({ password: false })
    expect((await attempt('ada')).status).toBe(403)
    expect(sessions()).toBe(before)
  })
})
