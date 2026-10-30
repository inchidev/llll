import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import { ingestServerEmail } from '../../workers/mail-ingress'
import { mailPushAccessAllowed } from '../../workers/push'
import type { L4Env } from '../../workers/env'
import { mailboxGrantsSql } from '../helpers/grants'

let sqlite: DatabaseSync, env: L4Env, kicks = 0
function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}
function receive(id: string, extra: string[] = []) {
  const raw = ['From: Customer <customer@example.net>', 'To: support@example.com', 'Subject: Invoice question', `Message-ID: ${id}`, ...extra, 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'Where is my invoice?'].join('\r\n')
  return ingestServerEmail({ from: 'customer@example.net', to: 'support@example.com', raw: stream(raw) }, env)
}
const outbox = () => sqlite.prepare('SELECT recipient_id AS recipient, kind, payload_json AS payload, channel_id AS channel FROM notification_outbox ORDER BY recipient_id').all() as Array<{ recipient: string; kind: string; payload: string; channel: string }>

beforeEach(() => {
  kicks = 0
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('mail-role', 'custom:mail', 'Mail', ${Permission.readMail}), ('chat-role', 'custom:chat', 'Chat', ${Permission.sendMessages});
    INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES
      ('owner', 'Owner', 'active', 'chat-role', '2026-09-01'), ('reader', 'Reader', 'active', 'mail-role', '2026-09-01'),
      ('no-grant', 'No grant', 'active', 'mail-role', '2026-09-01'), ('no-policy', 'No policy', 'active', 'chat-role', '2026-09-01'),
      ('mail-external', 'Email', 'removed', NULL, NULL);
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Mail test','owner');
    INSERT INTO channels (id, name, type, visibility) VALUES ('support', 'support', 'text', 'private');
    INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('main', 'zone', 'example.com', 'chat.example.com');
    INSERT INTO email_mailboxes (channel_id, domain_id, local_part, display_name) VALUES ('support', 'main', 'support', 'Support');
    ${mailboxGrantsSql(['support', 'owner', 'manage'], ['support', 'reader', 'read'], ['support', 'no-policy', 'read'])}
    INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES ('support', 'owner', '2026-09-01'), ('support', 'reader', '2026-09-01'), ('support', 'no-policy', '2026-09-01');
    INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES
      ('s-owner', 'owner', 'https://push.example/owner', 'k', 'a', 't', 't'), ('s-reader', 'reader', 'https://push.example/reader', 'k', 'a', 't', 't'),
      ('s-no-grant', 'no-grant', 'https://push.example/no-grant', 'k', 'a', 't', 't'), ('s-no-policy', 'no-policy', 'https://push.example/no-policy', 'k', 'a', 't', 't');
  `)
  env = { DB: d1(sqlite), FILES: { put: async () => {}, delete: async () => {} },
    SERVER_DO: { getByName: () => ({ notifyMailChanged: async () => {} }) }, NOTIFICATION_DO: { getByName: () => ({ kick: async () => { kicks += 1 } }) } } as unknown as L4Env
})
afterEach(() => sqlite.close())

it('pushes new mail to people who can read the mailbox, and nobody else', async () => {
  await receive('<first@example.net>')
  const thread = (sqlite.prepare('SELECT channel_id AS id FROM email_threads').get() as { id: string }).id
  const rows = outbox()
  expect(rows.map(row => row.recipient)).toEqual(['owner', 'reader'])
  expect(rows.every(row => row.kind === 'mail' && row.channel === thread)).toBe(true)
  expect(JSON.parse(rows[0]!.payload)).toMatchObject({ title: 'Customer · Support', url: `/mail/support/inbox?thread=${thread}`, tag: `mail:${thread}` })
  expect(JSON.parse(rows[0]!.payload).body).toContain('Invoice question')
  expect(kicks).toBe(1)
})

it('stays quiet for mail that lands in Spam or Trash', async () => {
  await receive('<first@example.net>')
  sqlite.exec("UPDATE email_threads SET status='spam'; DELETE FROM notification_outbox")
  await receive('<second@example.net>', ['In-Reply-To: <first@example.net>', 'References: <first@example.net>'])
  expect(outbox()).toEqual([])
})

it('drops a queued push once mailbox access or the email permission is removed', async () => {
  await receive('<first@example.net>')
  const thread = (sqlite.prepare('SELECT channel_id AS id FROM email_threads').get() as { id: string }).id
  expect(await mailPushAccessAllowed(env.DB, thread, 'reader')).toBe(true)
  expect(await mailPushAccessAllowed(env.DB, thread, 'owner')).toBe(true)
  sqlite.exec("UPDATE roles SET permissions_bitmask=0 WHERE id='mail-role'")
  expect(await mailPushAccessAllowed(env.DB, thread, 'reader')).toBe(false)
  sqlite.exec(`UPDATE roles SET permissions_bitmask=${Permission.readMail} WHERE id='mail-role'; DELETE FROM grants WHERE mailbox_id IS NOT NULL AND member_id='reader'`)
  expect(await mailPushAccessAllowed(env.DB, thread, 'reader')).toBe(false)
})
