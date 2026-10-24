import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({ env: null as L4Env | null, mailboxId: 'support' }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({ user: { id: 'owner' } }) }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => promise }) }))
let sqlite: DatabaseSync
let objects: Set<string>
let remove: ReturnType<typeof vi.fn>
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','member','Member',0);
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01');
    INSERT INTO channels(id,name,type,visibility) VALUES('support','Support','text','private'),('other','Other','text','private');
    INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain','zone','example.com','chat.example.com');
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('support','domain','support','Support');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('first','support','owner','Hello','2026-01-01');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('conversation','Hello','thread','private','support','first');
    INSERT INTO email_threads(channel_id,mailbox_channel_id,subject,last_message_at) VALUES('conversation','support','Hello','2026-01-01');
    INSERT INTO email_messages(message_id,thread_channel_id,mailbox_channel_id,direction,from_address,to_json,delivery_status,raw_r2_key,created_at)
      VALUES('first','conversation','support','inbound','customer@example.net','["support@example.com"]','received','mail/raw/first.eml','2026-01-01');
    INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES
      ('file1','first','support','owner','mail/attachments/first.txt','first.txt','text/plain',10,'2026-01-01'),
      ('unsent',NULL,'conversation','owner','mail/attachments/unsent.txt','unsent.txt','text/plain',10,'2026-01-01'),
      ('unrelated',NULL,'other','owner','other/file.txt','other.txt','text/plain',10,'2026-01-01');
  `)
  objects = new Set(['mail/raw/first.eml','mail/attachments/first.txt','mail/attachments/unsent.txt','other/file.txt','backup/snapshot'])
  remove = vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) objects.delete(key) })
  state.mailboxId = 'support'
  state.env = { DB: d1(sqlite), FILES: { delete: remove } } as unknown as L4Env
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (_event: unknown, key: string) => key === 'channelId' ? state.mailboxId : 'server')
  vi.stubGlobal('setResponseStatus', vi.fn())
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
const deleteMailbox = async () => (await import('../../server/api/servers/[id]/mailboxes/[channelId].delete')).default({} as never)

describe('mailbox file deletion', () => {
  it('deletes raw mail and attachments, including unsent thread uploads, leaving unrelated files and backups', async () => {
    await deleteMailbox()
    expect(objects).toEqual(new Set(['other/file.txt', 'backup/snapshot']))
    expect(sqlite.prepare("SELECT id FROM channels WHERE id IN ('support','conversation')").all()).toEqual([])
  })
  it('retains cleanup keys on a storage failure and permits retry after the mailbox row is gone', async () => {
    remove.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(deleteMailbox()).rejects.toMatchObject({ statusCode: 503, data: { error: { code: 'mail_cleanup_pending' } } })
    expect(sqlite.prepare('SELECT count(*) as n FROM file_deletions').get()).toEqual({ n: 3 })
    expect(sqlite.prepare("SELECT channel_id FROM email_mailboxes WHERE channel_id = 'support'").get()).toBeUndefined()
    await deleteMailbox()
    expect(objects).toEqual(new Set(['other/file.txt', 'backup/snapshot']))
    expect(sqlite.prepare('SELECT count(*) as n FROM file_deletions').get()).toEqual({ n: 0 })
  })
  it('rolls back the cleanup queue if the mailbox cannot be removed', async () => {
    sqlite.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON channels WHEN OLD.id = 'support' BEGIN SELECT RAISE(ABORT, 'cannot delete'); END")
    await expect(deleteMailbox()).rejects.toThrow('cannot delete')
    expect(remove).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) as n FROM file_deletions').get()).toEqual({ n: 0 })
    expect(sqlite.prepare("SELECT id FROM channels WHERE id = 'support'").get()).toEqual({ id: 'support' })
  })
  it('resumes pending cleanup on a later Mail refresh', async () => {
    remove.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(deleteMailbox()).rejects.toMatchObject({ statusCode: 503 })
    const { retryMailFileCleanup } = await import('../../server/utils/mail-cleanup')
    await retryMailFileCleanup(state.env!)
    expect(objects).toEqual(new Set(['other/file.txt', 'backup/snapshot']))
    expect(sqlite.prepare('SELECT count(*) as n FROM file_deletions').get()).toEqual({ n: 0 })
  })

})
