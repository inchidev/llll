import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { listGrantedMailboxes } from '../../server/utils/mail-data'
import { Permission } from '../../shared/permissions'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync, env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE email_domains(id TEXT, domain TEXT);
    CREATE TABLE email_mailboxes(channel_id TEXT, domain_id TEXT, local_part TEXT, display_name TEXT, enabled INTEGER);
    CREATE TABLE grants(member_id TEXT, mailbox_id TEXT, permissions INTEGER);
    CREATE TABLE email_threads(channel_id TEXT, mailbox_channel_id TEXT, status TEXT);
    CREATE TABLE email_messages(message_id TEXT, thread_channel_id TEXT, direction TEXT);
    CREATE TABLE channel_reads(channel_id TEXT, user_id TEXT, last_read_message_id TEXT);
    CREATE TABLE channels(id TEXT, space_id TEXT);
    INSERT INTO channels VALUES ('box', '${DEFAULT_SPACE_ID}');
    INSERT INTO email_domains VALUES ('d', 'example.com');
    INSERT INTO email_mailboxes VALUES ('box', 'd', 'hello', 'Hello', 1);`)
  db.prepare('INSERT INTO grants VALUES (?, ?, ?)').run('me', 'box', Permission.readMail)
  env = { DB: d1(db) } as unknown as L4Env
})
afterEach(() => db.close())

function thread(id: string, messages: Array<[string, 'inbound' | 'outbound']>, status = 'inbox') {
  db.prepare('INSERT INTO email_threads VALUES (?, ?, ?)').run(id, 'box', status)
  for (const [message, direction] of messages) db.prepare('INSERT INTO email_messages VALUES (?, ?, ?)').run(message, id, direction)
}
const unread = async () => (await listGrantedMailboxes(env, 'me'))[0]?.unreadCount

it('does not count an email you sent and never opened', async () => {
  thread('sent', [['m1', 'outbound']])
  expect(await unread()).toBe(0)
})

it('counts a conversation with an inbound email nobody read', async () => {
  thread('new', [['m1', 'inbound']])
  expect(await unread()).toBe(1)
})

it('counts it again only when a newer inbound email arrives', async () => {
  thread('t', [['m1', 'inbound'], ['m2', 'outbound']])
  db.prepare('INSERT INTO channel_reads VALUES (?, ?, ?)').run('t', 'me', 'm1')
  expect(await unread()).toBe(0)
  db.prepare('INSERT INTO email_messages VALUES (?, ?, ?)').run('m3', 't', 'inbound')
  expect(await unread()).toBe(1)
})

it('ignores conversations outside the Inbox', async () => {
  thread('old', [['m1', 'inbound']], 'archive')
  expect(await unread()).toBe(0)
})
