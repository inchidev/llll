import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { deliverOutboundEmail } from '../../server/utils/mail-outbound'
import migration from '../../drizzle/server-migrations/0014_mail_delivery.sql?raw'

const state = vi.hoisted(() => ({ env: null as L4Env | null, confirmed: false, canSend: true, path: 'conversation', bodyId: 'reply-0001' }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => promise }) }))
vi.mock('../../server/utils/server-mail', async original => ({
  ...await original<typeof import('../../server/utils/server-mail')>(),
  requireMailboxPermission: async (_event: unknown, _id: string, permission: string) => {
    expect(permission).toBe('send')
    if (!state.canSend) throw Object.assign(new Error('Mailbox is read only'), { statusCode: 403 })
    return { user: { id: 'owner' }, mailboxId: 'support', channel: { type: 'thread' } }
  },
}))
let sqlite: DatabaseSync
let send: ReturnType<typeof vi.fn>
let take: ReturnType<typeof vi.fn>
const fixture = `
  INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','member','Member',${ALL_PERMISSIONS});
  INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01');
  INSERT INTO channels(id,name,type,visibility) VALUES('support','Support','text','private');
  INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain','zone','example.com','chat.example.com');
  INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('support','domain','support','Support');
  INSERT INTO email_mailbox_access(channel_id,user_id,permission) VALUES('support','owner','manage');
  INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('first','support','owner','Hello','2026-01-01');
  INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('conversation','Hello','thread','private','support','first');
  INSERT INTO email_threads(channel_id,mailbox_channel_id,subject,participants_json,last_message_at) VALUES('conversation','support','Hello','["recipient@example.net"]','2026-01-01');
  INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('reply-0001','conversation','owner','Again','2026-01-01');
  INSERT INTO email_messages(message_id,thread_channel_id,mailbox_channel_id,direction,from_address,to_json,delivery_status,delivery_attempts,created_at)
    VALUES('reply-0001','conversation','support','outbound','support@example.com','["recipient@example.net"]','pending',1,'2026-01-01');
`
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(fixture)
  send = vi.fn(async () => ({ messageId: '<receipt@example.com>' }))
  take = vi.fn(async () => true)
  state.env = { DB: d1(sqlite), MAIL_EMAIL: { send }, RATE_LIMIT_DO: { getByName: () => ({ take }) }, SERVER_DO: { getByName: () => ({ notifyMailChanged: async () => {} }) } } as unknown as L4Env
  state.confirmed = false; state.canSend = true; state.path = 'conversation'; state.bodyId = 'reply-0001'
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => state.path)
  vi.stubGlobal('readBody', async () => ({ messageId: state.bodyId, confirmUncertain: state.confirmed }))
})
afterEach(() => { sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
const retry = async () => (await import('../../server/api/mail/threads/[id]/retry.post')).default({} as never)

describe('uncertain mail recovery', () => {
  it('requires explicit confirmation before retrying an expired attempt', async () => {
    await expect(retry()).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'delivery_uncertain' } } })
    expect(send).not.toHaveBeenCalled()
    expect(take).not.toHaveBeenCalled()
    state.confirmed = true
    const result = await retry()
    expect(result.message.email?.deliveryStatus).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('never retries a fresh pending or already sent email', async () => {
    state.confirmed = true
    sqlite.prepare("UPDATE email_messages SET delivery_started_at = ?").run(new Date().toISOString())
    await expect(retry()).rejects.toMatchObject({ statusCode: 409 })
    sqlite.exec("UPDATE email_messages SET delivery_status = 'sent'")
    await expect(retry()).rejects.toMatchObject({ statusCode: 409 })
    expect(send).not.toHaveBeenCalled()
  })
  it('keeps permission, conversation and rate checks on recovery', async () => {
    state.confirmed = true; state.canSend = false
    await expect(retry()).rejects.toMatchObject({ statusCode: 403 })
    state.canSend = true; state.path = 'other-thread'
    await expect(retry()).rejects.toMatchObject({ statusCode: 404 })
    state.path = 'conversation'; take.mockResolvedValue(false)
    await expect(retry()).rejects.toMatchObject({ statusCode: 429 })
    expect(send).not.toHaveBeenCalled()
  })
  it('does not let a late receipt overwrite a newer attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
    sqlite.exec("UPDATE email_messages SET delivery_attempts = 0")
    let finish: (value: { messageId: string }) => void = () => {}
    let entered: () => void = () => {}
    const sending = new Promise<void>(resolve => { entered = resolve })
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered() }))
    const first = deliverOutboundEmail(state.env!, 'reply-0001')
    await sending
    vi.setSystemTime(new Date('2026-10-23T10:06:00Z'))
    await deliverOutboundEmail(state.env!, 'reply-0001', { retryUncertain: true })
    finish({ messageId: '<late@example.com>' })
    await first
    expect(sqlite.prepare('SELECT delivery_attempts, provider_message_id FROM email_messages').get()).toEqual({ delivery_attempts: 2, provider_message_id: '<receipt@example.com>' })
  })
  it('upgrades a populated database without losing Mail and clears synthetic IDs', () => {
    const previous = new DatabaseSync(':memory:')
    try {
      previous.exec(INIT_SQL.slice(0, INIT_SQL.indexOf('ALTER TABLE email_messages ADD COLUMN provider_message_id')))
      previous.exec(fixture)
      previous.exec("UPDATE email_messages SET rfc_message_id = 'cloudflare:recipient@example.net'")
      previous.exec(migration)
      expect(previous.prepare('SELECT rfc_message_id, provider_message_id, reply_to_json, delivery_attempts FROM email_messages').get()).toEqual({
        rfc_message_id: null, provider_message_id: 'cloudflare:recipient@example.net', reply_to_json: '[]', delivery_attempts: 1,
      })
      expect(previous.prepare('SELECT count(*) as n FROM messages').get()).toEqual({ n: 2 })
    } finally { previous.close() }
  })
})
