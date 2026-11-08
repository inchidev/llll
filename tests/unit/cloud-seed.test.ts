import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { provisionServerWithEnv } from '../../server/utils/bootstrap'
import { applyCloudSeed, readCloudSeed } from '../../server/utils/cloud-seed'
import { authenticateMcpRequest } from '../../server/utils/mcp-access'
import { cloudSeedSchema, seedTokenScopes } from '../../shared/cloud-seed'
import { sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

/**
 * ADR 0012, the account and agent doors: a person claims at /setup, and the claim creates what the seed asks
 * for besides the Owner. This is the part of `/api/setup/owner` after the Owner exists, on the same code the
 * relay's `claim-owner` runs.
 */
const SERVER = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'
const AGENT_TOKEN = 'dfmcp_' + '0f'.repeat(32)
let sqlite: DatabaseSync, env: L4Env
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON'); sqlite.exec(INIT_SQL)
  sqlite.prepare('INSERT INTO server_identity(singleton,id) VALUES(1,?)').run(SERVER)
  env = { DB: d1(sqlite), AUTH_SECRET: 'test-server-secret-with-32-characters', PUBLIC_ORIGIN: 'https://paper-planes.llll.gg',
    SERVER_DO: { getByName: () => ({ notifyMembersChanged: async () => {} }) } } as unknown as L4Env
})
afterEach(() => sqlite.close())

async function seeded(seed: unknown) {
  sqlite.prepare("INSERT INTO server_setup(singleton,username,token_hash,server_name,seed_json,created_at,updated_at) VALUES(1,NULL,'hash','Paper Planes',?,'2026-11-08','2026-11-08')").run(JSON.stringify(seed))
  return readCloudSeed(env.DB)
}

describe('the seed a claim applies', () => {
  it('reads the seed the control plane left, and nothing when there is none or it is malformed', async () => {
    expect(await readCloudSeed(env.DB)).toBeNull()
    expect(await seeded({ agent: { name: 'Claude' } })).toBeNull()
    sqlite.prepare('UPDATE server_setup SET seed_json=?').run('{not json')
    expect(await readCloudSeed(env.DB)).toBeNull()
    sqlite.prepare('UPDATE server_setup SET seed_json=?').run(JSON.stringify({ agent: { name: 'Claude', role: 'admin', token: { hash: 'ab'.repeat(32), prefix: 'l4a.', scopes: [] } } }))
    expect(await readCloudSeed(env.DB)).toEqual({ agent: { name: 'Claude', role: 'admin', token: { hash: 'ab'.repeat(32), prefix: 'l4a.', scopes: [] }, instructions: '', version: 1 }, secrets: {}, env: {} })
    expect(cloudSeedSchema.safeParse({ owner: { identity: { provider: 'afterprompt', subject: '' } } }).success).toBe(false)
    // A partner's seed, as llll-cloud sends it: an Owner identity, an Agent without a token, secrets and env.
    const partner = cloudSeedSchema.safeParse({ owner: { identity: { provider: 'afterprompt', subject: 'acct_1' }, name: 'Ivan', username: 'ivan' }, agent: { name: 'Claude', role: 'admin', instructions: 'x'.repeat(100_000), version: 3 }, secrets: { K: { value: 'v'.repeat(8192), hosts: [] } }, env: { U: 'https://x' } })
    expect(partner.success).toBe(true)
    expect(partner.data?.agent?.token).toBeUndefined()
    expect(seedTokenScopes(['tasks:read', 'not-a-scope', 'mail:read'])).toEqual(['tasks:read', 'mail:read'])
  })

  it('creates the seed’s Agent under the Owner, whose token then acts as the Agent delegated by the Owner', async () => {
    const seed = (await seeded({
      agent: { name: 'Claude', role: 'admin', token: { hash: await sha256Hex(AGENT_TOKEN), prefix: 'l4a.', scopes: ['tasks:read', 'tasks:write'] }, instructions: 'Organize the work on paper planes.', version: 1 },
    }))!
    // What /api/setup/owner does: the Owner from the form, then the seed.
    const { userId: ownerId } = await provisionServerWithEnv(env, { username: 'ivan', password: 'a-long-enough-password', handle: 'ivan', displayName: 'Ivan', serverName: 'Paper Planes' })
    const applied = await applyCloudSeed(env, { serverId: SERVER, ownerId, seed })
    sqlite.prepare('DELETE FROM server_setup').run()

    const agent = sqlite.prepare("SELECT u.id,u.status,r.key AS role,a.created_by,a.instructions,a.model FROM users u JOIN roles r ON r.id=u.role_id JOIN agents a ON a.user_id=u.id WHERE u.kind='agent'").get() as { id: string; status: string; role: string; created_by: string; instructions: string; model: string }
    expect(agent).toMatchObject({ id: applied.agentId, status: 'active', role: 'cloud-agent', created_by: ownerId, instructions: 'Organize the work on paper planes.' })
    const role = sqlite.prepare("SELECT permissions_bitmask AS permissions, is_system AS system FROM roles WHERE key='cloud-agent'").get() as { permissions: number; system: number }
    const admin = sqlite.prepare("SELECT permissions_bitmask AS permissions FROM roles WHERE key='admin'").get() as { permissions: number }
    expect(role.system).toBe(0)
    expect(role.permissions & admin.permissions).toBe(admin.permissions)
    expect(role.permissions & (1 << 12)).toBeTruthy()
    const token = sqlite.prepare('SELECT name,token_prefix,scopes_json,subject_id,created_by FROM mcp_access_tokens').get()
    expect(token).toEqual({ name: 'Claude on L4 Cloud', token_prefix: 'l4a.', scopes_json: '["tasks:read","tasks:write"]', subject_id: agent.id, created_by: ownerId })
    expect(sqlite.prepare("SELECT action FROM audit_log ORDER BY created_at,id").all().map(row => (row as { action: string }).action)).toEqual(['server.create', 'agent.create', 'mcp_token.create'])

    const principal = await authenticateMcpRequest(env, new Request('https://paper-planes.llll.gg/mcp', { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }))
    expect(principal).toMatchObject({ userId: agent.id, delegatedBy: ownerId, roleName: 'Cloud agent', scopes: ['tasks:read', 'tasks:write'] })
    expect(principal?.authorization.principal.kind).toBe('agent')
    expect(principal?.authorization.delegation).toMatchObject({ by: ownerId, isOwner: true })
    expect(await authenticateMcpRequest(env, new Request('https://paper-planes.llll.gg/mcp', { headers: { Authorization: `Bearer dfmcp_${'11'.repeat(32)}` } }))).toBeNull()
    // No identity in the seed on the account door: none is recorded.
    expect(sqlite.prepare('SELECT count(*) AS n FROM member_identities').get()).toEqual({ n: 0 })
  })

  it('applies a seed twice without a second Agent or token, and records the Owner’s identity when the seed names one', async () => {
    const seed = (await seeded({
      owner: { identity: { provider: 'afterprompt', subject: 'acct_1' } },
      agent: { name: 'Claude', role: 'admin', token: { hash: await sha256Hex(AGENT_TOKEN), prefix: 'l4a.', scopes: [] }, instructions: '', version: 1 },
      secrets: { KEY: { value: 'v' } },
    }))!
    const { userId: ownerId } = await provisionServerWithEnv(env, { username: 'ivan', password: 'a-long-enough-password', handle: 'ivan', displayName: 'Ivan', serverName: 'Paper Planes' })
    const first = await applyCloudSeed(env, { serverId: SERVER, ownerId, seed })
    const second = await applyCloudSeed(env, { serverId: SERVER, ownerId, seed })
    expect(second.agentId).toBe(first.agentId)
    expect(sqlite.prepare("SELECT count(*) AS n FROM users WHERE kind='agent'").get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM mcp_access_tokens').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT provider,subject,user_id FROM member_identities').all()).toEqual([{ provider: 'afterprompt', subject: 'acct_1', user_id: ownerId }])
    // An empty scope list means the default set, as a token made without scopes gets.
    expect(JSON.parse((sqlite.prepare('SELECT scopes_json FROM mcp_access_tokens').get() as { scopes_json: string }).scopes_json)).toContain('tasks:read')
    expect(JSON.parse((sqlite.prepare('SELECT scopes_json FROM mcp_access_tokens').get() as { scopes_json: string }).scopes_json)).not.toContain('mail:read')
  })
})
