import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { d1 } from '../helpers/sqlite-d1'
import { canConfigurePush, ensurePushKeys, loadPushKeys } from '../../workers/push-keys'
import type { L4Env } from '../../workers/env'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { drainNotificationOutbox } from '../../workers/push'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
const env = { DB: d1(db), AUTH_SECRET: 'test-auth-secret-at-least-32-characters', PUBLIC_ORIGIN: 'https://server.example' } as L4Env
afterEach(() => db.exec('DELETE FROM server_settings'))

it('creates one stable encrypted identity even when members enable push concurrently', async () => {
  expect(await loadPushKeys(env)).toBeNull()
  const keys = await Promise.all(Array.from({ length: 8 }, () => ensurePushKeys(env)))
  expect(keys.every(item => item?.publicKey === keys[0]?.publicKey)).toBe(true)
  expect(keys[0]?.subject).toBe('https://server.example')
  const saved = db.prepare('SELECT value FROM server_settings').get() as { value: string }
  expect(saved.value).not.toContain(keys[0]!.privateKey)
  expect(await loadPushKeys(env)).toEqual(keys[0])
})

it('keeps an operator-configured identity and refuses incomplete configuration', async () => {
  const configured = { ...env, VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:owner@example.com' }
  expect(await ensurePushKeys(configured)).toEqual({ publicKey: 'public', privateKey: 'private', subject: 'mailto:owner@example.com' })
  expect(db.prepare('SELECT count(*) AS count FROM server_settings').get()?.count).toBe(0)
  const incomplete = { ...env, VAPID_PUBLIC_KEY: 'public' }
  expect(canConfigurePush(incomplete)).toBe(false)
  expect(await ensurePushKeys(incomplete)).toBeNull()
})

it('uses the generated identity to send a queued notification to the push service', async () => {
  const fixture = mcpFixture()
  Object.assign(fixture.env, { PUBLIC_ORIGIN: 'https://server.example' })
  const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    await ensurePushKeys(fixture.env)
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    fixture.db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('subscription', ids.member, 'https://push.example/message', p256dh, auth, '2026-01-01', '2026-01-01')
    fixture.db.prepare('INSERT INTO notification_outbox(event_id,subscription_id,recipient_id,kind,channel_id,payload_json,available_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('event', 'subscription', ids.member, 'mention', 'public-chat', JSON.stringify({ title: 'Hello', body: 'Message', tag: 'event', url: '/channels/public-chat', icon: '', badge: '' }), '2026-01-01', '2026-01-01')
    await drainNotificationOutbox(fixture.env)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fixture.db.prepare('SELECT delivered_at FROM notification_outbox').get()?.delivered_at).toBeTruthy()
  } finally {
    fixture.db.close()
    vi.unstubAllGlobals()
  }
})
