import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

const state = vi.hoisted(() => ({ env: null as L4Env | null, actor: 'admin-001', id: 'thread-001', body: {} as Record<string, unknown> }))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: state.actor, kind: 'human' }) }))
vi.mock('../../server/utils/cf', async original => ({
  ...await original<typeof import('../../server/utils/cf')>(),
  cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => promise }),
}))
vi.mock('../../server/utils/live', () => ({ revalidateLiveRooms: vi.fn(async () => {}), liveRoom: vi.fn() }))

let sqlite: DatabaseSync
let notify: ReturnType<typeof vi.fn>
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
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('admin-role','admin','Admin',${Permission.manageChannels | Permission.sendMessages | Permission.readTasks});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('admin-001','human','Admin','active','admin-role','2026-10-23'),
      ('agent-001','agent','Agent','active','admin-role','2026-10-23');
    INSERT INTO agents(user_id,created_by) VALUES('agent-001','admin-001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Lifecycle','admin-001');
    INSERT INTO channels(id,name,type,visibility,created_at) VALUES('general-001','general','text','server','2026-10-23'),
      ('mailbox-001','support','text','private','2026-10-23'),('discussion-001','task-1','text','server','2026-10-23');
    INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain-001','zone','example.test','mail.example.test');
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('mailbox-001','domain-001','support','Support');
    INSERT INTO task_boards(id,name,created_by) VALUES('board-001','Board','admin-001');
    INSERT INTO tasks(id,board_id,title,created_by,discussion_channel_id) VALUES('task-001','board-001','Task','admin-001','discussion-001');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('root-001','general-001','admin-001','Ask the agent','2026-10-23'),('root-002','general-001','admin-001','Plain thread','2026-10-23');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES
      ('thread-001','Agent thread','thread','server','general-001','root-001'),('thread-002','Plain','thread','server','general-001','root-002');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('reply-001','thread-001','admin-001','Please help','2026-10-23');
    INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES('session-001','agent-001','thread-001','2026-10-23','2026-10-23');
    INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,source_message_id,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
      VALUES('run-001','session-001','agent-001','thread-001','admin-001','reply-001','reply-001','completed','Please help','model','','{}','2999-01-01','2026-10-23','2026-10-23');
  `)
  notify = vi.fn(async () => {})
  state.env = { DB: d1(sqlite), SERVER_DO: { getByName: () => ({ notifyChannelsChanged: notify }) } } as unknown as L4Env
  state.actor = 'admin-001'
  state.id = 'thread-001'
})
afterEach(() => sqlite.close())

const event = { method: 'DELETE', path: '/api/channels/thread-001' }
const remove = async () => (await import('../../server/api/channels/[id].delete')).default(event as never)
const exists = (id: string) => Boolean(sqlite.prepare('SELECT 1 FROM channels WHERE id=?').get(id))

describe('channel and Thread deletion', () => {
  it('keeps a Thread with Agent Runs and answers 409 instead of a failed query', async () => {
    await expect(remove()).rejects.toMatchObject({ statusCode: 409 })
    expect(exists('thread-001')).toBe(true)
    expect(sqlite.prepare('SELECT status FROM agent_runs WHERE id=?').get('run-001')).toMatchObject({ status: 'completed' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps a channel whose Thread has Agent Runs', async () => {
    sqlite.exec(`INSERT INTO channels(id,name,type,visibility,created_at) VALUES('random-001','random','text','server','2026-10-24')`)
    state.id = 'general-001'
    await expect(remove()).rejects.toMatchObject({ statusCode: 409 })
    expect(exists('general-001')).toBe(true)
  })

  it('deletes a Thread without Runs, even when only one chat channel remains, and tells clients', async () => {
    state.id = 'thread-002'
    await expect(remove()).resolves.toEqual({ ok: true })
    expect(exists('thread-002')).toBe(false)
    expect(exists('general-001')).toBe(true)
    expect(notify).toHaveBeenCalledWith({ t: 'channels.changed', serverId: '00000000-0000-4000-8000-000000000001', deletedIds: ['thread-002'], parentIds: ['general-001'] }, undefined)
  })

  it('does not count mailboxes or task discussions as remaining chat channels', async () => {
    sqlite.exec(`DELETE FROM agent_runs; DELETE FROM agent_sessions;`)
    state.id = 'general-001'
    await expect(remove()).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Cannot delete the last channel' })
    sqlite.exec(`INSERT INTO channels(id,name,type,visibility,created_at) VALUES('random-001','random','text','server','2026-10-24')`)
    await expect(remove()).resolves.toEqual({ ok: true })
    expect(exists('general-001') || exists('thread-001') || exists('thread-002')).toBe(false)
    expect(notify.mock.calls[0]![0]).toMatchObject({ deletedIds: ['general-001', 'thread-001', 'thread-002'], parentIds: [] })
  })

  it('tells only members about a deleted private channel', async () => {
    sqlite.exec(`INSERT INTO channels(id,name,type,visibility,created_by) VALUES('secret-001','secret','text','private','admin-001');
      INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('secret-001','admin-001','2026-10-23')`)
    state.id = 'secret-001'
    await remove()
    expect(notify.mock.calls[0]![1]).toEqual(['admin-001'])
  })

  it('refuses to delete a direct message', async () => {
    sqlite.exec(`INSERT INTO channels(id,name,type,visibility) VALUES('dm-001','dm','dm','private');
      INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('dm-001','admin-001','2026-10-23'),('dm-001','agent-001','2026-10-23')`)
    state.id = 'dm-001'
    await expect(remove()).rejects.toMatchObject({ statusCode: expect.any(Number) })
    expect(exists('dm-001')).toBe(true)
  })
})
