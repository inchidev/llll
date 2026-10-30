import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { drainNotificationOutbox } from '../../workers/push'
import type { L4Env } from '../../workers/env'
import web from '../../apps/site/src/index'
import { createRelayToken, openRelayToken } from '../../apps/site/src/telegram'
import type { WebEnv } from '../../apps/site/src/env'
import { verifyMiniAppData } from '../../shared/telegram'

const SERVER = '00000000-0000-4000-8000-000000000001'
const SHELL = 'https://web.example.com'
const BOT = '123456:test-bot-token'

async function signedLaunch(userId: number, authDate: number) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: 'Ada' }) })
  const encoder = new TextEncoder()
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(BOT))
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const data = [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([name, value]) => `${name}=${value}`).join('\n')
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))].map(b => b.toString(16).padStart(2, '0')).join('')
  params.set('hash', hash)
  return params.toString()
}

describe('Telegram relay on the official site', () => {
  let sqlite: DatabaseSync
  let env: WebEnv
  const post = (path: string, body: object, origin: string | null = SHELL) => web.fetch(new Request(SHELL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  }), env)

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync('apps/site/migrations/0000_web_baseline.sql', 'utf8'))
    env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('static') } as Fetcher, AUTH_SECRET: 'test-secret-'.repeat(5), PUBLIC_ORIGIN: SHELL, TELEGRAM_BOT_TOKEN: BOT }
  })
  afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

  it('seals the chat and Server into a stable token the Server cannot read', async () => {
    const token = await createRelayToken(env, 42, SERVER)
    expect(await createRelayToken(env, 42, SERVER)).toBe(token)
    expect(await createRelayToken(env, 43, SERVER)).not.toBe(token)
    expect(token).not.toContain('42')
    expect(await openRelayToken(env, token)).toEqual({ v: 1, c: 42, s: SERVER })
    expect(await openRelayToken({ ...env, AUTH_SECRET: 'other-secret-'.repeat(5) }, token)).toBeNull()
  })

  it('accepts launch data up to an hour old for subscribing, and only signed data', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fresh = await post('/api/telegram/subscribe', { initData: await signedLaunch(42, now - 1800), serverId: SERVER })
    expect(fresh.status).toBe(200)
    const { token } = await fresh.json() as { token: string }
    expect(await openRelayToken(env, token)).toMatchObject({ c: 42, s: SERVER })
    expect((await post('/api/telegram/subscribe', { initData: await signedLaunch(42, now - 7200), serverId: SERVER })).status).toBe(401)
    const forged = (await signedLaunch(42, now)).replace('Ada', 'Eve')
    expect((await post('/api/telegram/subscribe', { initData: forged, serverId: SERVER })).status).toBe(401)
    await expect(verifyMiniAppData(await signedLaunch(42, now - 1800), BOT)).rejects.toThrow()
  })

  it('sends a content-free message with an Open button, and reports gone subscriptions', async () => {
    const token = await createRelayToken(env, 42, SERVER)
    const sent: Array<{ chat_id: number; text: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } }> = []
    let status = 200
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      expect(input).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`)
      sent.push(JSON.parse(String(init.body)))
      return Response.json(status === 200 ? { ok: true } : { ok: false, description: 'Forbidden: bot was blocked by the user' }, { status })
    })
    const body = { token, serverId: SERVER, serverName: 'Friends', kind: 'mention', path: '/channels/abc' }
    // Servers call from their Worker, with no browser Origin.
    expect((await post('/api/telegram/notify', body, null)).status).toBe(200)
    expect(sent[0]).toMatchObject({ chat_id: 42, text: 'You were mentioned on Friends' })
    expect(sent[0]!.reply_markup.inline_keyboard[0]![0]!.web_app.url).toBe(`${SHELL}/${SERVER}/channels/abc`)
    expect((await post('/api/telegram/notify', { ...body, serverId: '00000000-0000-4000-8000-000000000002' }, null)).status).toBe(410)
    status = 403
    expect((await post('/api/telegram/notify', body, null)).status).toBe(410)
  })
})

describe('Telegram delivery from a Server', () => {
  let sqlite: DatabaseSync
  let env: L4Env

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
    sqlite.exec(`
      INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('member', 'custom:member', 'Member', 0);
      INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'member', '2026-09-01');
      INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
      INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Friends','owner');
      INSERT INTO channels (id, name, type, visibility) VALUES ('general', 'general', 'text', 'server');
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at, transport, relay_origin, relay_token)
        VALUES ('tg', 'owner', 'telegram:abc', '', '', 't', 't', 'telegram', '${SHELL}', 'opaque-relay-token-123');
      INSERT INTO notification_outbox (event_id, subscription_id, recipient_id, kind, channel_id, payload_json, attempts, available_at, created_at)
        VALUES ('message:1', 'tg', 'owner', 'mention', 'general', '{"title":"Ada mentioned you in #general","body":"secret plans","tag":"message:1","url":"/channels/general"}', 0, '2000-01-01T00:00:00.000Z', 't');
    `)
    env = { DB: d1(sqlite), EMBED_ORIGINS: SHELL } as unknown as L4Env
  })
  afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

  it('relays only the kind, Server and path, without VAPID keys', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), body: JSON.parse(String(init.body)) })
      return Response.json({ delivered: true })
    })
    await drainNotificationOutbox(env)
    expect(calls).toEqual([{ url: `${SHELL}/api/telegram/notify`, body: { token: 'opaque-relay-token-123', serverId: SERVER, serverName: 'Friends', kind: 'mention', path: '/channels/general' } }])
    expect(JSON.stringify(calls)).not.toContain('secret plans')
    expect(sqlite.prepare('SELECT delivered_at FROM notification_outbox').get()).toMatchObject({ delivered_at: expect.any(String) })
  })

  it('drops the subscription when the relay says it is gone or is no longer trusted', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 410 }))
    await drainNotificationOutbox(env)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 })
  })

  it('never posts the token to a relay outside the embed origins', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    env = { ...env, EMBED_ORIGINS: '' } as L4Env
    sqlite.exec(`UPDATE push_subscriptions SET relay_origin = 'https://evil.example'`)
    await drainNotificationOutbox(env)
    expect(fetch).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 })
  })
})
