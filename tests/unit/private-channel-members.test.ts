import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { privatePushAccessAllowed } from '../../workers/push'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { requireChannelAccess } from '../../server/utils/guards'

const state = vi.hoisted(() => ({ env: null as L4Env | null, actor: 'manager-001', channel: 'private-001', target: 'member-001', body: {} as Record<string, unknown> }))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: state.actor, kind: 'human' }) }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => promise }) }))
let beforeMutation: (() => void) | null = null
let sqlite: DatabaseSync
let revalidate: ReturnType<typeof vi.fn>
let notify: ReturnType<typeof vi.fn>
function binding(): D1Database {
  function prepare(sql: string) {
    let args: SQLInputValue[] = []
    const statement = {
      bind(...values: SQLInputValue[]) { args = values; return statement },
      async first() {
        if (/^(INSERT OR IGNORE INTO channel_members|DELETE FROM channel_members)/u.test(sql) && beforeMutation) { const mutate = beforeMutation; beforeMutation = null; mutate() }
        return sqlite.prepare(sql).get(...args) ?? null
      },
      async all() { return { results: sqlite.prepare(sql).all(...args) } },
      async raw() { const query = sqlite.prepare(sql); query.setReturnArrays(true); return query.all(...args) },
      async run() { return { success: true, meta: sqlite.prepare(sql).run(...args) } },
    }
    return statement
  }
  return { prepare } as unknown as D1Database
}
beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (_event: unknown, key: string) => key === 'userId' ? state.target : state.channel)
  vi.stubGlobal('readBody', async () => state.body)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  beforeMutation = null
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('manager-role','admin','Manager',${Permission.manageChannels | Permission.sendMessages}),('member-role','member','Member',${Permission.sendMessages});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-001','human','Owner','active','manager-role','2026-10-23'),
      ('manager-001','human','Manager','active','manager-role','2026-10-23'),
      ('member-001','human','Member','active','member-role','2026-10-23'),
      ('other-001','human','Other','active','member-role','2026-10-23'),
      ('agent-001','agent','Agent','active','member-role','2026-10-23'),
      ('removed-001','human','Removed','removed',NULL,NULL);
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Private test','owner-001');
    INSERT INTO channels(id,name,type,visibility) VALUES('private-001','secret','text','private'),('public-001','general','text','server'),('dm-001','dm','dm','private'),('mailbox-001','mail','text','private');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('root-001','private-001','manager-001','Private root','2026-10-23');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread-001','Thread','thread','server','private-001','root-001');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES
      ('private-001','manager-001','2026-10-23'),('private-001','other-001','2026-10-23'),
      ('dm-001','manager-001','2026-10-23'),('dm-001','member-001','2026-10-23'),('mailbox-001','manager-001','2026-10-23');
  `)
  revalidate = vi.fn(async () => {})
  notify = vi.fn(async () => {})
  state.env = { DB: binding(), CHANNEL_DO: { getByName: (name: string) => ({ revalidateAccess: () => revalidate(name) }) }, SERVER_DO: { getByName: () => ({ notifyChannelAccessChanged: notify }) } } as unknown as L4Env
  state.actor = 'manager-001'; state.channel = 'private-001'; state.target = 'member-001'; state.body = { userId: state.target }
})
afterEach(() => sqlite.close())
const event = { method: 'POST', path: '/api/channels/private-001/members' }
const add = async () => (await import('../../server/api/channels/[id]/members.post')).default(event as never)
const list = async () => (await import('../../server/api/channels/[id]/members.get')).default(event as never)
const remove = async () => (await import('../../server/api/channels/[id]/members/[userId].delete')).default(event as never)

describe('private channel member management', () => {
  it('lists members for an authorized channel manager', async () => {
    expect((await list()).members.map(member => member.user.id).sort()).toEqual(['manager-001', 'other-001'])
  })
  it('adds an active Member idempotently and grants inherited Thread access', async () => {
    await add()
    const joinedAt = sqlite.prepare('SELECT joined_at FROM channel_members WHERE channel_id=? AND user_id=?').get(state.channel, state.target)?.joined_at
    await add()
    expect(sqlite.prepare('SELECT count(*) AS n FROM channel_members WHERE channel_id=? AND user_id=?').get(state.channel, state.target)).toMatchObject({ n: 1 })
    expect(sqlite.prepare('SELECT joined_at FROM channel_members WHERE channel_id=? AND user_id=?').get(state.channel, state.target)?.joined_at).toBe(joinedAt)
    state.actor = state.target
    await expect(requireChannelAccess(event as never, 'thread-001')).resolves.toHaveProperty('channel.id', 'thread-001')
  })
  it('removes channel and inherited Thread access and revalidates both active rooms', async () => {
    await add()
    notify.mockClear(); revalidate.mockClear()
    sqlite.exec(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES('push-001','member-001','https://push.example/fixture','key','auth','2026-10-23','2026-10-23');
      INSERT INTO notification_outbox(event_id,subscription_id,recipient_id,kind,channel_id,payload_json,available_at,created_at)
      VALUES('queued-001','push-001','member-001','mention','thread-001','{}','2026-10-23','2026-10-23');`)
    expect(await privatePushAccessAllowed(state.env!.DB, 'thread-001', state.target)).toBe(true)
    await remove()
    expect(await privatePushAccessAllowed(state.env!.DB, 'thread-001', state.target)).toBe(false)
    expect(sqlite.prepare("SELECT last_error,failed_at FROM notification_outbox WHERE event_id='queued-001'").get()).toMatchObject({ last_error: 'access_revoked', failed_at: expect.any(String) })
    expect(revalidate.mock.calls.map(call => call[0]).sort()).toEqual(['channel:private-001', 'channel:thread-001'])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ revoked: true, channelId: 'private-001' }), ['member-001'])
    const audit = sqlite.prepare("SELECT meta_json FROM audit_log WHERE action='channel.member.remove'").get()
    expect(JSON.parse(String(audit?.meta_json))).toMatchObject({ userId: 'member-001' })
    state.actor = state.target
    for (const id of ['private-001', 'thread-001']) await expect(requireChannelAccess(event as never, id)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('does not grant the Server Owner access to a private channel they have not joined', async () => {
    state.actor = 'owner-001'
    for (const operation of [list, add, remove]) await expect(operation()).rejects.toMatchObject({ statusCode: 404 })
  })
  it('denies management to an ordinary participant', async () => {
    state.actor = 'other-001'
    for (const operation of [list, add, remove]) await expect(operation()).rejects.toMatchObject({ statusCode: 403 })
  })
  it.each(['public-001', 'dm-001', 'thread-001'])('cannot manage %s through private-channel endpoints', async id => {
    state.channel = id
    for (const operation of [list, add, remove]) await expect(operation()).rejects.toMatchObject({ statusCode: expect.any(Number) })
  })
  it('rejects Mailbox membership changes through the channel API', async () => {
    sqlite.exec(`INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain-001','zone','test.example','test.example');
      INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('mailbox-001','domain-001','mail','Mail');
      INSERT INTO email_mailbox_access(channel_id,user_id,permission) VALUES('mailbox-001','manager-001','manage');`)
    state.channel = 'mailbox-001'
    for (const operation of [list, add, remove]) await expect(operation()).rejects.toMatchObject({ statusCode: 403 })
  })
  it('permits adding an Agent only with the explicit Role grant', async () => {
    sqlite.prepare('UPDATE roles SET permissions_bitmask=permissions_bitmask | ? WHERE id=?').run(Permission.useAgents, 'manager-role')
    state.body = { userId: 'agent-001' }
    expect((await add()).members.some(member => member.user.id === 'agent-001')).toBe(true)
  })
  it('keeps duplicate removals idempotent without telling non-members about the private channel', async () => {
    await remove()
    expect(notify.mock.calls.some(call => call[0].revoked)).toBe(false)
    expect((await list()).members).toHaveLength(2)
  })
  it.each(['add', 'remove'])('does not let a removed manager complete a stale %s request', async operation => {
    state.target = 'other-001'
    if (operation === 'add') state.body = { userId: 'member-001' }
    beforeMutation = () => sqlite.prepare('DELETE FROM channel_members WHERE channel_id=? AND user_id=?').run(state.channel, state.actor)
    await expect(operation === 'add' ? add() : remove()).rejects.toMatchObject({ statusCode: 404 })
    expect(sqlite.prepare('SELECT user_id FROM channel_members WHERE channel_id=? ORDER BY user_id').all(state.channel)).toEqual([{ user_id: 'other-001' }])
  })
  it('rejects inactive targets without modifying access', async () => {
    state.body = { userId: 'removed-001' }
    await expect(add()).rejects.toMatchObject({ statusCode: 400 })
  })
  it('requires Use agents to grant a private channel to an Agent', async () => {
    state.body = { userId: 'agent-001' }
    await expect(add()).rejects.toMatchObject({ statusCode: 403 })
  })
  it('prevents a manager from removing their own access accidentally', async () => {
    state.target = state.actor
    await expect(remove()).rejects.toMatchObject({ statusCode: 400 })
  })
})
