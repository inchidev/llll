import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from '../../server/utils/better-auth'
import { INIT_SQL } from '../../server/utils/db'
import { createMcpConnection, hashMcpToken, listMcpConnections, mcpConsentSubjects, revokeMcpConnection } from '../../server/utils/mcp-oauth'
import { authenticateMcpRequest, requireMcpAccess } from '../../server/utils/mcp-access'
import { Permission } from '../../shared/permissions'
import type { AuthRuntimeConfig } from '../../server/utils/auth-config'
import type { L4Env } from '../../workers/env'
import type { McpScope } from '../../shared/mcp'

const origin = 'https://community.example'
const resource = `${origin}/mcp`
let sqlite: DatabaseSync
let env: L4Env
let ownerId: string
let cookie: string
let clientId: string

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...next: SQLInputValue[]) { values = next; return statement },
        async first<T>() { return (database.prepare(sql).get(...values) as T | undefined) ?? null },
        async all<T>() { return { results: database.prepare(sql).all(...values) as T[], success: true, meta: {} } },
        async raw() {
          const query = database.prepare(sql)
          query.setReturnArrays(true)
          return query.all(...values)
        },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) } },
      }
      return statement
    },
    async batch(statements: Array<{ all: () => Promise<unknown> }>) { return Promise.all(statements.map(statement => statement.all())) },
  } as unknown as D1Database
}

const config: AuthRuntimeConfig = {
  mode: 'builtin', registrationMode: 'open',
  enabled: { email: true, github: false, google: false, linkedin: false, twitter: false, telegram: false, turnstile: false },
  credentials: {}, email: { binding: false, from: null, fromName: null, senderManagedByDeployment: false, verificationReady: false },
}
const auth = (connectionId?: string) => createAuth(env, origin, undefined, config, connectionId, true)

async function call(path: string, options: { method?: string; body?: unknown; form?: URLSearchParams; cookie?: string; connectionId?: string } = {}) {
  const engine = await auth(options.connectionId)
  return engine.handler(new Request(`${origin}/api/auth${path}`, {
    method: options.method || (options.body || options.form ? 'POST' : 'GET'),
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.form?.toString() || (options.body ? JSON.stringify(options.body) : undefined),
  }))
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(INIT_SQL)
  sqlite.exec("INSERT INTO server_identity(singleton,id) VALUES (1,'00000000-0000-4000-8000-000000000001')")
  env = { DB: d1(sqlite), PUBLIC_ORIGIN: origin, AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters' } as L4Env
  const response = await call('/sign-up/email', { body: { name: 'Owner', email: 'owner@example.com', password: 'TestPassword123456!' } })
  expect(response.status, await response.clone().text()).toBe(200)
  ownerId = (await response.json()).user.id
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  sqlite.prepare("INSERT INTO roles (id,key,name,permissions_bitmask) VALUES ('owner-role','owner','Owner',0), ('member-role','member','Member',?), ('agent-role','agent','Agent',?)")
    .run(Permission.manageTasks | Permission.mcpConnect, Permission.manageTasks | Permission.manageDatabases | Permission.mcpConnect)
  sqlite.prepare("INSERT INTO users (id,display_name,status,role_id,joined_at) VALUES (?,'Owner','active','owner-role','2026-10-21'), ('other-human','Other','active','member-role','2026-10-21')").run(ownerId)
  sqlite.exec("INSERT INTO users (id,kind,display_name,status,role_id,joined_at) VALUES ('agent-member','agent','Builder','active','agent-role','2026-10-21')")
  sqlite.prepare("INSERT INTO server (id,name,owner_id) VALUES ('00000000-0000-4000-8000-000000000001','L4',?)").run(ownerId)
  const registration = await call('/oauth2/register', { body: {
    client_name: 'Test client', redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  } })
  expect(registration.status, await registration.clone().text()).toBe(201)
  clientId = (await registration.json()).client_id
})

afterEach(() => sqlite.close())

async function authorization(subjectId = ownerId, scopes: McpScope[] = ['tasks:read'], options: { resource?: string; accept?: boolean } = {}) {
  const verifier = 'a'.repeat(64)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const challenge = Buffer.from(digest).toString('base64url')
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: 'http://127.0.0.1:4567/callback',
    scope: [...scopes, 'offline_access'].join(' '), resource: options.resource || resource,
    state: 'client-state', code_challenge: challenge, code_challenge_method: 'S256' })
  const response = await call(`/oauth2/authorize?${query}`, { cookie })
  expect(response.status, await response.clone().text()).toBe(302)
  const location = new URL(response.headers.get('location')!, origin)
  if (options.resource) return { location, verifier, connectionId: '', callback: location }
  expect(location.pathname).toBe('/mcp/authorize')
  const connectionId = options.accept === false ? undefined : await createMcpConnection(env, { createdBy: ownerId, subjectId, clientId, resource, scopes })
  const consent = await call('/oauth2/consent', { cookie, connectionId, body: { accept: options.accept !== false, oauth_query: location.search.slice(1), scope: [...scopes, 'offline_access'].join(' ') } })
  expect(consent.status, await consent.clone().text()).toBe(200)
  const callback = new URL((await consent.json()).url)
  expect(callback.searchParams.get('state')).toBe('client-state')
  expect(callback.searchParams.get('iss')).toBe(`${origin}/api/auth`)
  return { location, verifier, connectionId: connectionId || '', callback }
}

async function exchange(code: string, verifier: string, extra: Record<string, string> = {}) {
  return call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
    redirect_uri: 'http://127.0.0.1:4567/callback', code, code_verifier: verifier, resource, ...extra }) })
}

async function connect(subjectId = ownerId, scopes: McpScope[] = ['tasks:read']) {
  const grant = await authorization(subjectId, scopes)
  expect(grant.callback.searchParams.has('code'), grant.callback.toString()).toBe(true)
  const response = await exchange(grant.callback.searchParams.get('code')!, grant.verifier)
  expect(response.status, await response.clone().text()).toBe(200)
  return { ...grant, tokens: await response.json() as { access_token: string; refresh_token: string; scope: string } }
}

const principal = (token: string, endpoint = resource) => authenticateMcpRequest(env, new Request(endpoint, { headers: { Authorization: `Bearer ${token}` } }), undefined, endpoint)

describe('MCP OAuth with the installed provider and real SQL storage', () => {
  it('discovers PKCE, native DCR and scoped user access, then rotates refresh credentials', async () => {
    const metadata = await (await auth()).api.getOAuthServerConfig()
    expect(metadata).toMatchObject({ issuer: `${origin}/api/auth`, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'] })
    const { tokens } = await connect()
    expect(tokens.access_token).toMatch(/^l4_at_/)
    expect(tokens.refresh_token).toMatch(/^l4_rt_/)
    expect(await principal(tokens.access_token)).toMatchObject({ userId: ownerId, isOwner: true, scopes: ['tasks:read'] })
    const stored = sqlite.prepare('SELECT token FROM auth_oauth_access_token').get()!.token
    expect(stored).toBe(await hashMcpToken(tokens.access_token.slice('l4_at_'.length)))
    const refreshed = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }) })
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    const next = await refreshed.json()
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect(await principal(next.access_token)).toMatchObject({ userId: ownerId })
    const replay = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }) })
    expect(replay.status).toBe(400)
    expect(await principal(next.access_token)).toBeNull()
  })

  it('binds Agent authorship, client and delegator; current role and scopes cap every call', async () => {
    const { tokens } = await connect('agent-member', ['documents:read'])
    const agent = await principal(tokens.access_token)
    expect(agent).toMatchObject({ userId: 'agent-member', delegatedBy: ownerId, authorization: { credential: { clientId } } })
    expect(() => requireMcpAccess(agent!, 'tasks:read')).toThrow('tasks:read scope')
    sqlite.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='agent-role'").run(Permission.mcpConnect)
    const downgraded = await principal(tokens.access_token)
    expect(() => requireMcpAccess(downgraded!, 'documents:read')).toThrow('Agent role')
  })

  it('allows ordinary humans to connect themselves, and never impersonate another human or Agent', async () => {
    expect((await mcpConsentSubjects(env, 'other-human')).map(subject => subject.id)).toEqual(['other-human'])
    await expect(createMcpConnection(env, { createdBy: 'other-human', subjectId: 'agent-member', clientId, resource, scopes: ['tasks:read'] })).rejects.toThrow()
    await expect(createMcpConnection(env, { createdBy: ownerId, subjectId: 'other-human', clientId, resource, scopes: ['tasks:read'] })).rejects.toThrow()
    await expect(createMcpConnection(env, { createdBy: 'other-human', subjectId: 'other-human', clientId, resource, scopes: ['documents:read'] })).rejects.toThrow()
  })

  it('rejects wrong PKCE, code replay and a foreign resource', async () => {
    const grant = await authorization()
    const code = grant.callback.searchParams.get('code')!
    expect((await exchange(code, 'b'.repeat(64))).status).toBe(400)
    const valid = await authorization()
    expect((await exchange(valid.callback.searchParams.get('code')!, valid.verifier)).status).toBe(200)
    expect((await exchange(valid.callback.searchParams.get('code')!, valid.verifier)).status).toBe(400)
    const denied = await authorization(ownerId, ['tasks:read'], { resource: 'https://another.example/mcp' })
    expect(denied.location.searchParams.get('error')).toBe('invalid_target')
  })

  it.each(['human', 'agent', 'delegator'])('blocks issued access, refresh and outstanding codes when the %s loses mcp.connect', async (kind) => {
    if (kind !== 'agent') {
      sqlite.exec("UPDATE server SET owner_id='other-human'")
      sqlite.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='owner-role'").run(Permission.manageServer | Permission.manageTasks | Permission.mcpConnect)
    }
    const subjectId = kind === 'human' ? ownerId : 'agent-member'
    const active = await connect(subjectId)
    const pending = await authorization(subjectId)
    expect(await principal(active.tokens.access_token)).toMatchObject({ userId: subjectId })
    const roleId = kind === 'agent' ? 'agent-role' : 'owner-role'
    sqlite.prepare('UPDATE roles SET permissions_bitmask=permissions_bitmask & ? WHERE id=?').run(~Permission.mcpConnect, roleId)
    expect(await principal(active.tokens.access_token)).toBeNull()
    const refresh = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: active.tokens.refresh_token, resource }) })
    expect(refresh.status).toBe(400)
    expect((await exchange(pending.callback.searchParams.get('code')!, pending.verifier)).status).toBe(400)
    await expect(createMcpConnection(env, { createdBy: ownerId, subjectId, clientId, resource, scopes: ['tasks:read'] })).rejects.toThrow('mcp.connect')
    expect((await listMcpConnections(env, ownerId)).some(connection => connection.id === active.connectionId)).toBe(true)
    expect(await revokeMcpConnection(env, active.connectionId, ownerId)).toBe(true)
  })

  it('denies consent without minting tokens and rejects bypass of Member selection', async () => {
    const denied = await authorization(ownerId, ['tasks:read'], { accept: false })
    expect(denied.callback.searchParams.get('error')).toBe('access_denied')
    const bypass = await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: denied.location.search.slice(1) } })
    expect(bypass.status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) as n FROM auth_oauth_access_token').get()!.n).toBe(0)
  })

  it('revokes access and refresh immediately and denies foreign-server or expired tokens', async () => {
    const { tokens, connectionId } = await connect('agent-member')
    expect(await principal(tokens.access_token, 'https://another.example/mcp')).toBeNull()
    expect(await listMcpConnections(env, 'other-human')).toEqual([])
    expect(await revokeMcpConnection(env, connectionId, 'other-human')).toBe(false)
    expect(await revokeMcpConnection(env, connectionId, ownerId)).toBe(true)
    expect(await principal(tokens.access_token)).toBeNull()
    const refreshed = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }) })
    expect(refreshed.status).toBe(400)
    const another = await connect()
    sqlite.exec('UPDATE auth_oauth_access_token SET expires_at=0')
    expect(await principal(another.tokens.access_token)).toBeNull()
  })

  it('stops Agent credentials when the delegator loses management or either Member is removed', async () => {
    const { tokens } = await connect('agent-member')
    sqlite.prepare("UPDATE server SET owner_id='other-human'").run()
    expect(await principal(tokens.access_token)).toBeNull()
    const refresh = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }) })
    expect(refresh.status).toBe(400)
  })

  it('rejects outstanding authorization codes after revocation, and invalidates logout and removed Agents', async () => {
    const pending = await authorization('agent-member')
    expect(await revokeMcpConnection(env, pending.connectionId, ownerId)).toBe(true)
    expect((await exchange(pending.callback.searchParams.get('code')!, pending.verifier)).status).toBe(400)
    const active = await connect('agent-member')
    sqlite.exec("UPDATE users SET status='removed',role_id=NULL,joined_at=NULL WHERE id='agent-member'")
    expect(await principal(active.tokens.access_token)).toBeNull()
    const removedRefresh = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: active.tokens.refresh_token, resource }) })
    expect(removedRefresh.status).toBe(400)
    const self = await connect()
    sqlite.exec('DELETE FROM auth_sessions')
    expect(await principal(self.tokens.access_token)).toBeNull()
    const logoutRefresh = await call('/oauth2/token', { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: self.tokens.refresh_token, resource }) })
    expect(logoutRefresh.status).toBe(400)
  })
})
