import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { Permission } from '../../shared/permissions'
import { ChannelDurableObject } from '../../workers/channel-do'
import type { L4Env } from '../../workers/env'
import { sequentialRoundTrips } from '../helpers/round-trips'
import { mailboxGrantsSql } from '../helpers/grants'
import { d1 } from '../helpers/sqlite-d1'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
// What runs after the send has its own timing, and no sender waits for it.
vi.mock('../../workers/channel-activity', async original => ({ ...await original<object>(), signalChannelActivity: async () => {}, signalChannelRead: async () => {} }))
vi.mock('../../workers/agent-ingress', async original => ({ ...await original<object>(), signalAgentsForMessage: async () => {} }))
vi.mock('../../workers/notifications', async original => ({ ...await original<object>(), signalNotificationOutbox: async () => {} }))

const serverId = '00000000-0000-4000-8000-000000000001'
const send = Permission.sendMessages
let sqlite: DatabaseSync
let env: L4Env

type Sent = { t: string; code?: string; message?: { content: string } }
function socket(userId: string) {
  const sent: Sent[] = []
  return {
    sent,
    closed: null as number | null,
    send(raw: string) { sent.push(JSON.parse(raw) as Sent) },
    close(code: number) { this.closed = code },
    deserializeAttachment: () => ({ userId, sessionId: `session-${userId}`, user: { id: userId, kind: 'human', displayName: userId, avatarR2Key: null } }),
  }
}
type Socket = ReturnType<typeof socket>

function channelObject(channelId: string, sockets: Socket[], withEnv: L4Env = env) {
  const storage = new Map<string, unknown>()
  const ctx = {
    id: { name: `channel:${channelId}` },
    getWebSockets: () => sockets,
    waitUntil: () => {},
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value) },
      delete: async (key: string) => storage.delete(key),
      list: async () => new Map(),
    },
  }
  return new ChannelDurableObject(ctx as unknown as DurableObjectState, withEnv)
}

const create = (content = 'hello') => JSON.stringify({ t: 'message.create', content, clientId: `client-${Math.random()}` })
const sendOn = (object: ChannelDurableObject, from: Socket, content?: string) => object.webSocketMessage(from as unknown as WebSocket, create(content))

beforeEach(() => {
  vi.stubGlobal('WebSocketRequestResponsePair', vi.fn())
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member-role','custom:member','Member',${send}),('reader-role','custom:reader','Reader',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner','human','Owner','active','member-role','2026-01-01'),('member','human','Member','active','member-role','2026-01-01'),('other','human','Other','active','member-role','2026-01-01'),('reader','human','Reader','active','reader-role','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('open','open','text','server'),('secret','secret','text','private'),('walled','walled','text','server'),('pair','pair','dm','private');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('root-open','open','owner','a','2026-01-01'),('root-secret','secret','owner','b','2026-01-01');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread','thread','thread','server','open','root-open'),('secret-thread','secret-thread','thread','server','secret','root-secret');
    INSERT INTO channel_role_denies(channel_id,role_id,deny_mask,created_at) VALUES('walled','member-role',${send},'2026-01-01');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('pair','member','2026-01-01'),('pair','other','2026-01-01');`)
  sqlite.exec("INSERT OR IGNORE INTO space_members(space_id,user_id,role,joined_at) SELECT s.id,u.id,'member','2026-01-01' FROM spaces s CROSS JOIN users u")
  sqlite.exec('PRAGMA foreign_keys = OFF')
  for (const id of ['owner', 'member', 'other', 'reader']) {
    sqlite.prepare("INSERT INTO auth_sessions(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,0,0)").run(`session-${id}`, id, `token-${id}`, Date.now() + 3_600_000)
  }
  env = { DB: d1(sqlite) } as unknown as L4Env
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

const trips = (channelId: string, user: string, others: string[] = []) => {
  const from = socket(user)
  const sockets = [from, ...others.map(socket)]
  return sequentialRoundTrips(env, env => sendOn(channelObject(channelId, sockets, env), from))
}

/** Sends from `user` and says what came back on the socket. */
async function attempt(channelId: string, user: string, others: Socket[] = []) {
  const from = socket(user)
  await sendOn(channelObject(channelId, [from, ...others]), from)
  return { from, error: from.sent.find(message => message.t === 'error')?.code ?? null, delivered: from.sent.some(message => message.t === 'message') }
}

it('makes four trips to D1 for a message, a Thread included, and one more when someone else is online', async () => {
  await trips('open', 'member') // The Server ID stays known for the isolate's life.
  expect(await trips('open', 'member')).toBe(4)
  expect(await trips('open', 'owner')).toBe(4)
  expect(await trips('thread', 'member')).toBe(4)
  expect(await trips('open', 'member', ['other'])).toBe(5)
})

it('delivers a message to whoever may read it', async () => {
  const other = socket('other')
  await expect(attempt('open', 'member', [other])).resolves.toMatchObject({ error: null, delivered: true })
  expect(other.sent.map(message => message.t)).toEqual(['message'])
  await expect(attempt('thread', 'member')).resolves.toMatchObject({ error: null, delivered: true })
})

it('keeps a private channel and its Threads to its members', async () => {
  await expect(attempt('secret', 'member')).resolves.toMatchObject({ error: 'not_found', delivered: false })
  await expect(attempt('secret-thread', 'member')).resolves.toMatchObject({ error: 'not_found', delivered: false })
  sqlite.exec("INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('secret','member','2026-01-01')")
  await expect(attempt('secret', 'member')).resolves.toMatchObject({ error: null, delivered: true })
  await expect(attempt('secret-thread', 'member')).resolves.toMatchObject({ error: null, delivered: true })
})

it('applies Role permissions, a channel denial and its allowance, and lifts them for the Owner', async () => {
  await expect(attempt('open', 'reader')).resolves.toMatchObject({ error: 'forbidden' })
  await expect(attempt('walled', 'member')).resolves.toMatchObject({ error: 'forbidden' })
  await expect(attempt('walled', 'owner')).resolves.toMatchObject({ error: null, delivered: true })
  sqlite.exec(`INSERT INTO grants(id,channel_id,role_id,permissions,created_at) VALUES('allow','open','reader-role',${send},'2026-01-01')`)
  await expect(attempt('open', 'reader')).resolves.toMatchObject({ error: null, delivered: true })
})

it('closes the socket of a revoked session and tells nothing to it', async () => {
  sqlite.exec("DELETE FROM auth_sessions WHERE id = 'session-member'")
  const { from } = await attempt('open', 'member')
  expect(from.closed).toBe(4403)
  expect(from.sent).toEqual([])
})

it('at the next message, closes a held socket whose session ended, whose Member left the Space or whose access ended', async () => {
  const revoked = socket('other'), left = socket('reader')
  sqlite.exec("DELETE FROM auth_sessions WHERE id = 'session-other'; DELETE FROM space_members WHERE user_id = 'reader'")
  await expect(attempt('open', 'member', [revoked, left])).resolves.toMatchObject({ error: null, delivered: true })
  for (const held of [revoked, left]) {
    expect(held.closed).toBe(4403)
    expect(held.sent).toEqual([])
  }
})

it('refuses someone outside the Space, and a suspended Space to all but the Owner', async () => {
  sqlite.exec("UPDATE spaces SET suspended_at = '2026-01-01'")
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: 'not_found' })
  await expect(attempt('open', 'owner')).resolves.toMatchObject({ error: null, delivered: true })
  sqlite.exec("UPDATE spaces SET suspended_at = NULL; DELETE FROM space_members WHERE user_id = 'member'")
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: 'not_found' })
})

it('freezes a direct message once someone has left, and keeps an Agent conversation to those who may use Agents', async () => {
  await expect(attempt('pair', 'member')).resolves.toMatchObject({ error: null, delivered: true })
  sqlite.exec("UPDATE users SET status = 'removed' WHERE id = 'other'")
  await expect(attempt('pair', 'member')).resolves.toMatchObject({ error: 'frozen' })
  sqlite.exec("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('agent','agent','Agent','active','member-role','2026-01-01'); INSERT INTO channels(id,name,type,visibility) VALUES('with-agent','with-agent','dm','private'); INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('with-agent','member','2026-01-01'),('with-agent','agent','2026-01-01'); INSERT OR IGNORE INTO space_members(space_id,user_id,role,joined_at) SELECT id,'agent','member','2026-01-01' FROM spaces")
  await expect(attempt('with-agent', 'member')).resolves.toMatchObject({ error: 'not_found' })
  sqlite.exec(`UPDATE roles SET permissions_bitmask = ${send | Permission.useAgents} WHERE id = 'member-role'`)
  await expect(attempt('with-agent', 'member')).resolves.toMatchObject({ error: null, delivered: true })
})

it('follows a mailbox: closed without a grant, and read only without send', async () => {
  sqlite.exec(`UPDATE roles SET permissions_bitmask = ${send | Permission.readMail | Permission.sendMail} WHERE id = 'member-role';
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('open','domain','team','Team')`)
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: 'not_found' })
  sqlite.exec(mailboxGrantsSql(['open', 'member', 'read']))
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: 'forbidden' })
  sqlite.exec(`DELETE FROM grants; ${mailboxGrantsSql(['open', 'member', 'send'])}`)
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: null, delivered: true })
})

it("keeps a Task's discussion, and its Threads, to those who may read Tasks", async () => {
  sqlite.exec(`INSERT INTO task_boards(id,name,created_by) VALUES('board','Work','owner');
    INSERT INTO tasks(id,board_id,title,description,status,priority,position,created_by,created_at,updated_at,discussion_channel_id) VALUES('task','board','Task','','ready','normal',1,'owner','2026-01-01','2026-01-01','open')`)
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: 'not_found' })
  await expect(attempt('thread', 'member')).resolves.toMatchObject({ error: 'not_found' })
  sqlite.exec(`UPDATE roles SET permissions_bitmask = ${send | Permission.readTasks} WHERE id = 'member-role'`)
  await expect(attempt('open', 'member')).resolves.toMatchObject({ error: null, delivered: true })
})

it("streams an Agent's answer to who may watch it, narrows it after a private read and ends it", async () => {
  sqlite.exec("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('pi-agent','agent','Pi','active','member-role','2026-01-01')")
  sqlite.exec("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('member-1','human','Member One','active','member-role','2026-01-01')")
  sqlite.exec("INSERT OR IGNORE INTO space_members(space_id,user_id,role,joined_at) SELECT s.id,u.id,'member','2026-01-01' FROM spaces s CROSS JOIN users u")
  sqlite.prepare("INSERT INTO auth_sessions(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,0,0)").run('session-member-1', 'member-1', 'token-member-1', Date.now() + 3_600_000)
  // Someone outside the Space may not read the conversation.
  sqlite.exec("DELETE FROM space_members WHERE user_id = 'reader'")
  const member = socket('member-1'), other = socket('other'), reader = socket('reader')
  const object = channelObject('thread', [member, other, reader])
  const runId = '01990000-0000-4000-8000-000000000001'
  const update = (text: string, audience: 'channel' | 'initiator' = 'channel') => object.streamAgentReply({ runId, agentId: 'pi-agent', initiatedBy: 'member-1', audience, text })
  const streamed = (s: Socket) => s.sent.filter(message => message.t.startsWith('agent.stream')) as unknown as Array<{ t: string; at?: number; text?: string }>
  await update('')
  await update('Hel')
  await update('Hello')
  expect(streamed(other).map(({ t, at, text }) => ({ t, at, text }))).toEqual([
    { t: 'agent.stream', at: 0, text: '' }, { t: 'agent.stream', at: 0, text: 'Hel' }, { t: 'agent.stream', at: 3, text: 'lo' },
  ])
  expect(streamed(reader)).toEqual([])
  await update('Hello there', 'initiator')
  expect(streamed(other).at(-1)).toMatchObject({ t: 'agent.stream.end' })
  expect(streamed(member).at(-1)).toMatchObject({ t: 'agent.stream', at: 5, text: ' there' })
  await object.endAgentStream(runId)
  expect(streamed(member).at(-1)).toMatchObject({ t: 'agent.stream.end', runId })
  expect(streamed(other).filter(message => message.t === 'agent.stream')).toHaveLength(3)
})

it("posts an Agent's long answer whole, while a person's message keeps its limit", async () => {
  sqlite.exec("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('pi-agent','agent','Pi','active','member-role','2026-01-01'); INSERT INTO agents(user_id,created_by) VALUES('pi-agent','owner')")
  const reader = socket('other')
  const object = channelObject('open', [reader])
  const answer = 'A long answer. '.repeat(300)
  await object.postAgentMessage({ agentId: 'pi-agent', content: answer })
  expect(reader.sent.find(message => message.t === 'message')?.message?.content).toBe(answer.trim())
  await expect(object.postAgentMessage({ agentId: 'pi-agent', content: 'x'.repeat(12_001) })).rejects.toThrow()
  const person = socket('member')
  await sendOn(channelObject('open', [person]), person, 'y'.repeat(2001))
  expect(person.sent.some(message => message.t === 'message')).toBe(false)
})
