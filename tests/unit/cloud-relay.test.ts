import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { cloudRelay, purgeServerFiles } from '../../server/utils/cloud-relay'
import { authenticateMcpRequest } from '../../server/utils/mcp-access'
import { consumeSignInLink } from '../../server/utils/signin-link'
import { sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

const SECRET = 'cloud-secret-'.repeat(3)
const SERVER = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'
// As the agent door mints it: an ordinary Server access token, hashed whole.
const AGENT_TOKEN = 'dfmcp_' + 'ab'.repeat(32)
const identity = { provider: 'afterprompt', subject: 'acct_42' }

function fakeFiles(keys: string[]) {
  const objects = new Set(keys)
  return {
    objects,
    bucket: {
      async list({ limit = 1000, cursor }: { limit?: number; cursor?: string }) {
        const all = [...objects].sort()
        const start = cursor ? all.indexOf(cursor) + 1 : 0
        const page = all.slice(start, start + limit)
        const truncated = start + limit < all.length
        return { objects: page.map(key => ({ key })), truncated, cursor: truncated ? page.at(-1) : undefined }
      },
      async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item) },
    } as unknown as R2Bucket,
  }
}

const env = (extra: Partial<L4Env> = {}) => ({ LLLL_RUNTIME: 'cloud', CLOUD_SECRET: SECRET, ...extra }) as L4Env
const call = (path: string, init: RequestInit = {}, e: L4Env = env(), scheduled = vi.fn(async () => {})) =>
  cloudRelay(new Request(`https://acme.llll.gg${path}`, init), e, path, scheduled).then(response => ({ response, scheduled }))

describe('the L4 Cloud relay', () => {
  it('answers nothing outside its prefix', async () => {
    expect((await call('/api/setup/health')).response).toBeNull()
  })

  it('is 404 without the right bearer secret, the right method, or the cloud runtime', async () => {
    expect((await call('/.llll/cloud/scheduled', { method: 'POST' })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}x` } })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, env({ LLLL_RUNTIME: 'cloudflare' }))).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, env({ CLOUD_SECRET: undefined }))).response?.status).toBe(404)
    expect((await call('/.llll/cloud/other', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/claim-owner', { method: 'POST', headers: { authorization: `Bearer ${SECRET}x` } })).response?.status).toBe(404)
  })

  it('runs the scheduled work for the control plane', async () => {
    const { response, scheduled } = await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })
    expect(response?.status).toBe(200)
    expect(scheduled).toHaveBeenCalledOnce()
  })

  it('empties the files bucket, page by page, before the control plane deletes it', async () => {
    const files = fakeFiles(Array.from({ length: 1203 }, (_, index) => `files/${String(index).padStart(5, '0')}`))
    const { response } = await call('/.llll/cloud/purge-files', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, env({ FILES: files.bucket }))
    expect(await response?.json()).toEqual({ ok: true, deleted: 1203 })
    expect(files.objects.size).toBe(0)
    expect(await purgeServerFiles(env())).toBe(0)
  })
})

/**
 * ADR 0012: the partner and agent doors. The Server starts as the control plane leaves it, seeded and unclaimed,
 * and every action below acts as the Owner would from the interface.
 */
describe('the partner and agent doors', () => {
  let sqlite: DatabaseSync
  let e: L4Env
  const seed = {
    owner: { identity, name: 'Ivan', username: 'ivan' },
    agent: { name: 'Claude', role: 'admin', token: { hash: '', prefix: 'dfmcp_', scopes: ['tasks:read', 'tasks:write', 'messages:read', 'messages:write'] }, instructions: 'Organize the work.', version: 1 },
    secrets: { AFTERPROMPT_TOKEN: { value: 'apk_secret_value', hosts: ['afterprompt.games'] } },
    env: { AFTERPROMPT_URL: 'https://afterprompt.games' },
  }
  const post = (action: string, body?: unknown) => call(`/.llll/cloud/${action}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: body === undefined ? undefined : JSON.stringify(body) }, e)
    .then(async ({ response }) => ({ status: response!.status, body: await response!.json() as Record<string, unknown> }))
  const row = <T>(sql: string, ...values: Array<string | number>) => sqlite.prepare(sql).get(...values) as T | undefined

  beforeEach(async () => {
    seed.agent.token.hash = await sha256Hex(AGENT_TOKEN)
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON'); sqlite.exec(INIT_SQL)
    sqlite.prepare('INSERT INTO server_identity(singleton,id) VALUES(1,?)').run(SERVER)
    sqlite.prepare("INSERT INTO server_setup(singleton,username,token_hash,server_name,seed_json,created_at,updated_at) VALUES(1,'ivan','hash','Paper Planes',?,'2026-11-08','2026-11-08')").run(JSON.stringify(seed))
    e = env({
      DB: d1(sqlite), AUTH_SECRET: 'test-server-secret-with-32-characters', PUBLIC_ORIGIN: 'https://acme.llll.gg',
      SERVER_DO: { getByName: () => ({ notifyMembersChanged: async () => {} }) },
    } as unknown as Partial<L4Env>)
  })
  afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

  it('claims the Owner once from the seed, with the identity, the Agent and its token, and answers the same Owner again', async () => {
    const first = await post('claim-owner', {})
    expect(first.status).toBe(200)
    const ownerId = first.body.ownerId as string
    expect(first.body).toEqual({ ok: true, ownerId })
    expect(row<{ owner_id: string }>('SELECT owner_id FROM server')?.owner_id).toBe(ownerId)
    expect(row<{ username: string; email: string }>('SELECT username,email FROM auth_users WHERE id=?', ownerId)).toMatchObject({ username: 'ivan' })
    expect(row<{ email: string }>('SELECT email FROM auth_users WHERE id=?', ownerId)!.email).toMatch(/@no-email\.invalid$/)
    expect(row<{ user_id: string }>('SELECT user_id FROM member_identities WHERE provider=? AND subject=?', identity.provider, identity.subject)?.user_id).toBe(ownerId)
    expect(row('SELECT 1 FROM server_setup')).toBeUndefined()
    // The Agent, under admin, created by the Owner, holding the token the agent already has.
    const agent = row<{ id: string; role: string; created_by: string; instructions: string }>("SELECT u.id,r.key AS role,a.created_by,a.instructions FROM users u JOIN roles r ON r.id=u.role_id JOIN agents a ON a.user_id=u.id WHERE u.kind='agent' AND u.display_name='Claude'")!
    // `admin` cannot connect over MCP, so the seed's Agent gets Cloud agent: admin plus what an Agent needs to connect and work.
    expect(agent).toMatchObject({ role: 'cloud-agent', created_by: ownerId, instructions: 'Organize the work.' })
    expect(row<{ n: number }>("SELECT count(*) AS n FROM roles WHERE key='cloud-agent' AND is_system=0")?.n).toBe(1)
    expect(row<{ space_id: string }>('SELECT space_id FROM space_members WHERE user_id=?', agent.id)?.space_id).toBe('00000000-0000-4000-8000-00000000000d')
    const principal = await authenticateMcpRequest(e, new Request('https://acme.llll.gg/mcp', { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }))
    expect(principal).toMatchObject({ userId: agent.id, delegatedBy: ownerId, scopes: ['tasks:read', 'tasks:write', 'messages:read', 'messages:write'] })
    expect(principal?.authorization.delegation?.isOwner).toBe(true)
    expect(await authenticateMcpRequest(e, new Request('https://acme.llll.gg/mcp', { headers: { Authorization: `Bearer dfmcp_${'cd'.repeat(32)}` } }))).toBeNull()
    // Secrets and env wait for later Projects, encrypted, under one setting.
    const partner = row<{ value: string }>("SELECT value FROM server_settings WHERE key='cloud.partner'")!.value
    expect(partner).not.toContain('apk_secret_value')
    expect(JSON.parse(partner)).toMatchObject({ env: { AFTERPROMPT_URL: 'https://afterprompt.games' }, secrets: { AFTERPROMPT_TOKEN: { hosts: ['afterprompt.games'] } } })

    const again = await post('claim-owner')
    expect(again).toEqual({ status: 200, body: { ok: true, ownerId } })
    expect(row<{ n: number }>("SELECT count(*) AS n FROM users WHERE kind='agent'")?.n).toBe(1)
    expect(row<{ n: number }>('SELECT count(*) AS n FROM mcp_access_tokens')?.n).toBe(1)
  })

  it('refuses to claim a Server a person claims at /setup, and every other action before the claim', async () => {
    sqlite.prepare('UPDATE server_setup SET seed_json=?').run(JSON.stringify({ ...seed, owner: { name: 'Ivan' } }))
    expect((await post('claim-owner')).status).toBe(409)
    sqlite.prepare('UPDATE server_setup SET seed_json=NULL').run()
    expect((await post('claim-owner')).status).toBe(409)
    expect(await post('members/upsert', { identity, name: 'Petya', role: 'member' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Claim the Owner first') } })
    expect((await post('session-link', { identity })).status).toBe(409)
    expect((await post('agents/upsert', { name: 'Claude', role: 'admin', instructions: '', version: 1 })).status).toBe(409)
    expect(row('SELECT 1 FROM server')).toBeUndefined()
  })

  it('answers a plain refusal for a body that is not the action’s, never a fault', async () => {
    await post('claim-owner')
    expect(await post('members/upsert', { identity, role: 'member' })).toEqual({ status: 400, body: { error: 'Invalid request: name' } })
    expect(await post('members/upsert', { identity, name: 'Petya', role: 'admin' })).toEqual({ status: 400, body: { error: 'Invalid request: role' } })
    expect((await call('/.llll/cloud/members/upsert', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: '{not json' }, e)).response?.status).toBe(400)
  })

  it('keeps a partner’s Members by identity: made once, renamed after, removed as the Owner would, never the Owner', async () => {
    const { body: { ownerId } } = await post('claim-owner')
    const made = await post('members/upsert', { identity: { provider: 'afterprompt', subject: 'acct_7' }, name: 'Petya', role: 'member' })
    expect(made.status).toBe(200)
    const userId = made.body.userId as string
    expect(made.body).toEqual({ ok: true, userId, created: true })
    expect(row<{ status: string; role: string; display_name: string }>('SELECT u.status,r.key AS role,u.display_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?', userId)).toEqual({ status: 'active', role: 'member', display_name: 'Petya' })
    expect(row<{ email: string; email_verified: number }>('SELECT email,email_verified FROM auth_users WHERE id=?', userId)).toMatchObject({ email: `${userId}@no-email.invalid`, email_verified: 0 })
    expect(row<{ password: string }>("SELECT password FROM auth_accounts WHERE user_id=? AND provider_id='credential'", userId)?.password).toMatch(/^scrypt\$/)
    expect(row<{ space_id: string }>('SELECT space_id FROM space_members WHERE user_id=?', userId)?.space_id).toBe('00000000-0000-4000-8000-00000000000d')

    const renamed = await post('members/upsert', { identity: { provider: 'afterprompt', subject: 'acct_7' }, name: 'Pyotr' })
    expect(renamed.body).toEqual({ ok: true, userId, created: false })
    expect(row<{ display_name: string }>('SELECT display_name FROM users WHERE id=?', userId)?.display_name).toBe('Pyotr')
    expect(row<{ name: string }>('SELECT name FROM auth_users WHERE id=?', userId)?.name).toBe('Pyotr')
    expect(row<{ n: number }>("SELECT count(*) AS n FROM users WHERE kind='human'")?.n).toBe(2)

    sqlite.prepare("INSERT INTO auth_sessions(id,expires_at,token,user_id) VALUES('s1',?, 'tok', ?)").run(Date.now() + 60000, userId)
    sqlite.prepare("INSERT INTO mcp_access_tokens(id,name,token_hash,token_prefix,scopes_json,subject_id,created_by,created_at,updated_at) VALUES('t1','Key','h','dfmcp_','[]',?,?,'2026-11-08','2026-11-08')").run(userId, userId)
    const removed = await post('members/remove', { identity: { provider: 'afterprompt', subject: 'acct_7' } })
    expect(removed.body).toEqual({ ok: true, userId, removed: true })
    expect(row<{ status: string; role_id: string | null }>('SELECT status,role_id FROM users WHERE id=?', userId)).toEqual({ status: 'removed', role_id: null })
    expect(row('SELECT 1 FROM auth_sessions WHERE user_id=?', userId)).toBeUndefined()
    expect(row<{ revoked_at: string | null }>("SELECT revoked_at FROM mcp_access_tokens WHERE id='t1'")?.revoked_at).not.toBeNull()
    expect(await post('members/remove', { identity: { provider: 'afterprompt', subject: 'acct_7' } })).toEqual({ status: 200, body: { ok: true, userId, removed: false } })
    expect(await post('members/remove', { identity: { provider: 'afterprompt', subject: 'nobody' } })).toEqual({ status: 200, body: { ok: true, userId: null, removed: false } })
    // A removed Member the partner names again keeps their Account and is admitted again.
    expect((await post('members/upsert', { identity: { provider: 'afterprompt', subject: 'acct_7' }, name: 'Petya' })).body).toEqual({ ok: true, userId, created: false })
    expect(row<{ status: string }>('SELECT status FROM users WHERE id=?', userId)?.status).toBe('active')

    expect(await post('members/remove', { identity })).toMatchObject({ status: 409, body: { error: 'The Owner cannot be removed' } })
    expect(row<{ status: string }>('SELECT status FROM users WHERE id=?', ownerId as string)?.status).toBe('active')
  })

  it('mints a sign-in link that works once, within ten minutes, for an active Member only', async () => {
    await post('claim-owner')
    const answer = await post('session-link', { identity })
    expect(answer.status).toBe(200)
    const url = answer.body.url as string
    expect(url).toMatch(/^https:\/\/acme\.llll\.gg\/signin\/link#[0-9a-f]{64}$/)
    expect(Date.parse(answer.body.expiresAt as string) - Date.now()).toBeGreaterThan(9 * 60 * 1000)
    const token = url.split('#')[1]!
    // Only the digest is kept.
    expect(sqlite.prepare('SELECT identifier,value FROM auth_verifications').all()).toEqual([{ identifier: `signin-link:${await sha256Hex(token)}`, value: answer.body.ownerId ?? (row<{ owner_id: string }>('SELECT owner_id FROM server')!.owner_id) }])
    expect(await consumeSignInLink(e, token)).toBe(row<{ owner_id: string }>('SELECT owner_id FROM server')!.owner_id)
    expect(await consumeSignInLink(e, token)).toBeNull()
    expect(await consumeSignInLink(e, 'zz'.repeat(32))).toBeNull()

    const expired = (await post('session-link', { identity })).body.url as string
    sqlite.prepare('UPDATE auth_verifications SET expires_at=?').run(Date.now() - 1)
    expect(await consumeSignInLink(e, expired.split('#')[1]!)).toBeNull()

    expect((await post('session-link', { identity: { provider: 'afterprompt', subject: 'nobody' } })).status).toBe(404)
    await post('members/upsert', { identity: { provider: 'afterprompt', subject: 'acct_7' }, name: 'Petya' })
    await post('members/remove', { identity: { provider: 'afterprompt', subject: 'acct_7' } })
    expect((await post('session-link', { identity: { provider: 'afterprompt', subject: 'acct_7' } })).status).toBe(404)
  })

  it('keeps the seed’s Agent by name: the token only on creation, the instructions only when the version grows', async () => {
    const { body: { ownerId } } = await post('claim-owner')
    const agentId = row<{ id: string }>("SELECT id FROM users WHERE kind='agent'")!.id
    const same = await post('agents/upsert', { name: 'Claude', role: 'admin', instructions: 'Older words.', version: 1, token: { hash: 'cd'.repeat(32), prefix: 'dfmcp_', scopes: ['tasks:read'] } })
    expect(same.body).toEqual({ ok: true, agentId, created: false })
    expect(row<{ instructions: string }>('SELECT instructions FROM agents WHERE user_id=?', agentId)?.instructions).toBe('Organize the work.')
    expect(row<{ n: number }>('SELECT count(*) AS n FROM mcp_access_tokens')?.n).toBe(1)

    const newer = await post('agents/upsert', { name: 'Claude', role: 'admin', instructions: 'Newer words.', version: 2 })
    expect(newer.body).toEqual({ ok: true, agentId, created: false })
    expect(row<{ instructions: string }>('SELECT instructions FROM agents WHERE user_id=?', agentId)?.instructions).toBe('Newer words.')
    expect((await post('agents/upsert', { name: 'Claude', role: 'admin', instructions: 'Stale words.', version: 1 })).status).toBe(200)
    expect(row<{ instructions: string }>('SELECT instructions FROM agents WHERE user_id=?', agentId)?.instructions).toBe('Newer words.')

    // The Owner renamed the Agent: the Server still knows which one the seed means.
    sqlite.prepare("UPDATE users SET display_name='Clementine' WHERE id=?").run(agentId)
    expect((await post('agents/upsert', { name: 'Claude', role: 'admin', instructions: 'Third.', version: 3 })).body).toEqual({ ok: true, agentId, created: false })
    expect(row<{ display_name: string }>('SELECT display_name FROM users WHERE id=?', agentId)?.display_name).toBe('Clementine')

    // A second Agent, by another name, with its own token, created by the Owner.
    const other = await post('agents/upsert', { name: 'Scout', role: 'member', instructions: 'Scout.', version: 1, token: { hash: 'ef'.repeat(32), prefix: 'dfmcp_', scopes: ['tasks:read'] } })
    expect(other.body).toMatchObject({ ok: true, created: true })
    expect(row<{ created_by: string; subject_id: string }>("SELECT created_by,subject_id FROM mcp_access_tokens WHERE token_hash=?", 'ef'.repeat(32))).toEqual({ created_by: ownerId, subject_id: other.body.agentId })
    expect(row<{ key: string }>('SELECT r.key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?', other.body.agentId as string)?.key).toBe('member')
    expect(row<{ n: number }>("SELECT count(*) AS n FROM roles WHERE key='cloud-agent'")?.n).toBe(1)
    expect((await post('agents/upsert', { name: 'Nobody', role: 'no-such-role', instructions: '', version: 1 })).status).toBe(400)
  })

  it('keeps the partner’s secrets encrypted and never answers a value', async () => {
    await post('claim-owner')
    const answer = await post('secrets/set', { secrets: { OTHER_KEY: { value: 'plain-secret-value' } }, env: { OTHER_URL: 'https://example.test' } })
    expect(answer).toEqual({ status: 200, body: { ok: true, secrets: 1, env: 1 } })
    const stored = row<{ value: string }>("SELECT value FROM server_settings WHERE key='cloud.partner'")!.value
    expect(stored).not.toContain('plain-secret-value')
    expect(stored).not.toContain('apk_secret_value')
    expect(JSON.parse(stored)).toMatchObject({ secrets: { OTHER_KEY: { hosts: [], secret: { ciphertext: expect.any(String), iv: expect.any(String), version: 1 } } }, env: { OTHER_URL: 'https://example.test' } })
    expect((await post('secrets/set', { secrets: { 'bad name': { value: 'x' } }, env: {} })).status).toBe(400)
  })

  it('saves a model provider as Server settings → Models would, with the default model set once, and never returns the key', async () => {
    await post('claim-owner')
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer sk-or-partner-key/)
      return Response.json({ data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supported_parameters: ['tools'], context_length: 200000 }, { id: 'openai/gpt-5', name: 'GPT-5', supported_parameters: ['tools'] }] })
    })
    vi.stubGlobal('fetch', fetcher)
    const answer = await post('models/set', { provider: 'openrouter', key: 'sk-or-partner-key' })
    expect(answer).toEqual({ status: 200, body: { ok: true, configured: true, models: 2 } })
    const stored = row<{ value: string }>("SELECT value FROM server_settings WHERE key='agents.provider.openrouter'")!.value
    expect(stored).not.toContain('sk-or-partner-key')
    expect(JSON.parse(stored)).toMatchObject({ kind: 'openrouter', enabled: true, keyPreview: 'sk-o••••-key', models: [{ id: 'anthropic/claude-sonnet-4.5' }, { id: 'openai/gpt-5' }], secret: { ciphertext: expect.any(String) } })
    expect(row<{ value: string }>("SELECT value FROM server_settings WHERE key='agents.defaultModel'")?.value).toBe('l4:openrouter:anthropic/claude-sonnet-4.5')
    // A default the Owner chose stays.
    sqlite.prepare("UPDATE server_settings SET value='l4:openrouter:openai/gpt-5' WHERE key='agents.defaultModel'").run()
    expect((await post('models/set', { provider: 'openrouter', key: 'sk-or-partner-key-2' })).status).toBe(200)
    expect(row<{ value: string }>("SELECT value FROM server_settings WHERE key='agents.defaultModel'")?.value).toBe('l4:openrouter:openai/gpt-5')
    expect((await post('models/set', { provider: 'anthropic', key: 'x' })).status).toBe(400)
  })

  it('puts the Server to sleep by releasing its boxes on L4 Compute', async () => {
    await post('claim-owner')
    expect(await post('sleep', {})).toEqual({ status: 200, body: { ok: true, released: 0 } })
  })
})
