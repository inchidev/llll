import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'
import { persistMessageEdit } from '../../workers/message-edits'
import { signalAgentsForMessage } from '../../workers/agent-ingress'

const state = vi.hoisted(() => ({ env: null as L4Env | null, actor: 'author-001', id: 'message-001', body: {} as Record<string, unknown> }))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: state.actor, kind: 'human', displayName: 'Author' }) }))
vi.mock('../../server/utils/cf', async original => ({
  ...await original<typeof import('../../server/utils/cf')>(),
  cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => promise }),
}))

const ids = {
  author: '10000000-0000-4000-8000-000000000001',
  reader: '10000000-0000-4000-8000-000000000002',
  late: '10000000-0000-4000-8000-000000000003',
  agent: '10000000-0000-4000-8000-000000000004',
}
let sqlite: DatabaseSync
let received: ReturnType<typeof vi.fn>
beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => state.id)
  vi.stubGlobal('readBody', async () => state.body)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member-role','member','Member',${Permission.sendMessages | Permission.useAgents});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('${ids.author}','human','Author','active','member-role','2026-10-23'),
      ('${ids.reader}','human','Reader','active','member-role','2026-10-23'),
      ('${ids.late}','human','Late','active','member-role','2026-10-23'),
      ('${ids.agent}','agent','Agent','active','member-role','2026-10-23');
    INSERT INTO agents(user_id,created_by) VALUES('${ids.agent}','${ids.author}');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Edits','${ids.author}');
    INSERT INTO channels(id,name,type,visibility) VALUES('general-001','general','text','server'),('dm-001','dm','dm','private');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('dm-001','${ids.author}','2026-10-23'),('dm-001','${ids.agent}','2026-10-23');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('message-001','general-001','${ids.author}','Hi <@${ids.reader}>','2026-10-23'),
      ('dm-message','dm-001','${ids.author}','Hello','2026-10-23');
    INSERT INTO message_mentions(message_id,user_id) VALUES('message-001','${ids.reader}');
    INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES
      ('push-reader','${ids.reader}','https://push.example/r','k','a','2026-10-23','2026-10-23'),
      ('push-late','${ids.late}','https://push.example/l','k','a','2026-10-23','2026-10-23');
    INSERT INTO notification_outbox(event_id,subscription_id,recipient_id,kind,channel_id,payload_json,available_at,created_at)
      VALUES('message:message-001','push-reader','${ids.reader}','mention','general-001','{}','2026-10-23','2026-10-23');
  `)
  received = vi.fn(async () => 'run')
  state.env = {
    DB: d1(sqlite),
    CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) },
    NOTIFICATION_DO: { getByName: () => ({ kick: async () => {} }) },
    AGENT_DO: { getByName: () => ({ receiveMessage: received }) },
  } as unknown as L4Env
  state.actor = ids.author
  state.id = 'message-001'
})
afterEach(() => sqlite.close())

const edit = async () => (await import('../../server/api/messages/[id].patch')).default({ method: 'PATCH', path: '/api/messages/message-001' } as never)
const outbox = () => sqlite.prepare('SELECT recipient_id AS id FROM notification_outbox ORDER BY recipient_id').all().map(row => row.id)

describe('mentions added by editing', () => {
  it('notifies only the newly mentioned Member, once', async () => {
    state.body = { content: `Hi <@${ids.reader}> and <@${ids.late}>` }
    await edit()
    expect(outbox()).toEqual([ids.reader, ids.late])
    expect(sqlite.prepare('SELECT count(*) AS n FROM notification_outbox WHERE recipient_id=?').get(ids.reader)).toMatchObject({ n: 1 })
    // Removing and re-adding the mention does not notify again.
    state.body = { content: 'Hi everyone' }
    await edit()
    state.body = { content: `Hi <@${ids.late}>` }
    await edit()
    expect(sqlite.prepare('SELECT count(*) AS n FROM notification_outbox WHERE recipient_id=?').get(ids.late)).toMatchObject({ n: 1 })
    expect(sqlite.prepare('SELECT user_id FROM message_mentions WHERE message_id=?').all('message-001').map(row => row.user_id)).toEqual([ids.late])
  })

  it('signals an Agent mentioned by an edit, as a send does', async () => {
    state.body = { content: `Hi <@${ids.reader}>, <@${ids.agent}> can you help?` }
    await edit()
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1))
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'message-001', channelId: 'general-001', authorId: ids.author }))
    received.mockClear()
    state.body = { content: `Hi <@${ids.reader}>, <@${ids.agent}> can you help with this?` }
    await edit()
    expect(received).not.toHaveBeenCalled()
  })

  it('does not notify or re-address DM participants on an edit', async () => {
    const result = await persistMessageEdit(state.env!, {
      id: 'dm-message', channelId: 'dm-001', author: { id: ids.author, kind: 'human', displayName: 'Author', avatarR2Key: null },
      content: 'Hello again', mentions: [], editedAt: '2026-10-24',
    })
    expect(result).toEqual({ content: 'Hello again', added: [], notified: [] })
    await signalAgentsForMessage(state.env!, { messageId: 'dm-message', channelId: 'dm-001', authorId: ids.author, authorName: 'Author', content: 'Hello again', mentionIds: [], edit: true })
    expect(received).not.toHaveBeenCalled()
    expect(outbox()).toEqual([ids.reader])
  })
})
