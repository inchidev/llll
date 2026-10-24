import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL, getDb } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { Permission } from '../../shared/permissions'
import { removeMessageData, retryDeletedFiles } from '../../shared/file-cleanup'
import { messages } from '../../drizzle/schema'
import { hydrateMessages } from '../../server/utils/messages'
import { ChannelDurableObject } from '../../workers/channel-do'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
const state = vi.hoisted(() => ({ env: null as L4Env | null, id: 'message1', userId: 'owner', pending: [] as Promise<unknown>[] }))
vi.mock('../../server/utils/guards', () => ({ requireChannelMember: async () => ({ user: { id: state.userId } }), requireChannelAccess: async () => ({}) }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: (p: Promise<unknown>) => state.pending.push(p) }) }))
let sqlite: DatabaseSync
let remove: ReturnType<typeof vi.fn>
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','member','Member',0);
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','Chat','text','server');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('message1','chat','owner','hello','2026-01-01');
    INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at)
      VALUES('file1','message1','chat','owner','chat/blob','photo.png','image/png',10,'2026-01-01');`)
  remove = vi.fn(async () => {})
  state.env = { DB: d1(sqlite), FILES: { delete: remove, get: vi.fn(async () => ({ size: 10, body: 'blob' })) }, CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) } } as unknown as L4Env
  state.id = 'message1'; state.userId = 'owner'; state.pending = []
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => state.id)
  vi.stubGlobal('getHeader', () => undefined)
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('asRpc', (value: unknown) => value)
})
afterEach(async () => { await Promise.all(state.pending); sqlite.close(); vi.unstubAllGlobals() })
const deleteHttp = async () => (await import('../../server/api/messages/[id].delete')).default({} as never)
const download = async () => (await import('../../server/api/files/[id].get')).default({} as never)
const files = async () => (await import('../../server/api/channels/[id]/files.get')).default({} as never)

describe('deleted message attachments', () => {
  it.each(['http', 'websocket'])('revokes file access and retries blob cleanup after %s deletion', async transport => {
    remove.mockRejectedValueOnce(new Error('Storage unavailable'))
    if (transport === 'http') await deleteHttp()
    else {
      const instance = Object.create(ChannelDurableObject.prototype)
      Object.assign(instance, { env: state.env, ctx: { id: { name: 'channel:chat' }, getWebSockets: () => [], waitUntil: (p: Promise<unknown>) => state.pending.push(p) } })
      await instance.onDelete({ send: vi.fn() }, { userId: 'owner' }, { perms: Permission.sendMessages }, 'message1')
    }
    await Promise.all(state.pending)
    expect(sqlite.prepare('SELECT count(*) as n FROM attachments').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT key FROM file_deletions').all()).toEqual([{ key: 'chat/blob' }])
    state.id = 'file1'; await expect(download()).rejects.toMatchObject({ statusCode: 404 })
    state.id = 'chat'; expect((await files()).files).toEqual([])
    await Promise.all(state.pending)
    await retryDeletedFiles(state.env!)
    expect(remove).toHaveBeenLastCalledWith(['chat/blob'])
    expect(sqlite.prepare('SELECT count(*) as n FROM file_deletions').get()).toEqual({ n: 0 })
  })
  it('hides attachments on previously deleted messages in downloads, Files, and hydration', async () => {
    sqlite.exec("UPDATE messages SET deleted_at = '2026-10-24'")
    state.id = 'file1'; await expect(download()).rejects.toMatchObject({ statusCode: 404 })
    state.id = 'chat'; expect((await files()).files).toEqual([])
    const rows = await getDb(state.env!.DB).select().from(messages)
    expect((await hydrateMessages(state.env!, rows, 'owner'))[0]!.attachments).toEqual([])
    expect(state.env!.FILES!.get).not.toHaveBeenCalled()
  })
  it('keeps authorization and rolls back queued deletion when the transaction fails', async () => {
    state.userId = 'someone-else'
    await expect(deleteHttp()).rejects.toMatchObject({ statusCode: 403 })
    sqlite.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT, 'cannot delete'); END")
    await expect(removeMessageData(state.env!, 'message1', '2026-10-24')).rejects.toThrow('cannot delete')
    expect(sqlite.prepare('SELECT deleted_at FROM messages').get()).toEqual({ deleted_at: null })
    expect(sqlite.prepare('SELECT count(*) as n FROM file_deletions').get()).toEqual({ n: 0 })
  })
})
