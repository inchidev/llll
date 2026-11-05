import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { integrationsStatus, requireIntegrationOwner, updateIntegrations } from '../../server/utils/integrations'
import { toolsForRun } from '../../server/utils/agent-tools'
import { searchWeb } from '../../server/utils/agent-search'
import { acceptPostmarkInbound, emailInboundProvider } from '../../workers/inbound-email'
import { browserProvider, callsProvider, type L4Env } from '../../workers/env'
import { loadSavedIntegrations, saveIntegrations, withIntegrations } from '../../workers/integrations'
import { sendServerEmail, serverEmailProvider } from '../../workers/mail-transport'
import { Permission } from '../../shared/permissions'

let f: ReturnType<typeof mcpFixture>, env: L4Env
const secret32 = 'x'.repeat(40)
beforeEach(() => { f = mcpFixture(); env = { ...f.env, LLLL_RUNTIME: 'celld' } as L4Env })
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
/** Another isolate's save: this isolate's cache does not hear about it. */
const saveOther = async () => {
  const { encryptSecret } = await import('../../shared/encrypted-secret')
  f.db.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES('server.integrations',?,'2026-11-05')").run(JSON.stringify(await encryptSecret(env.AUTH_SECRET!, 'server-integrations', JSON.stringify({ EXA_API_KEY: 'exa-synthetic-key' }))))
}
const stored = () => (f.db.prepare("SELECT value FROM server_settings WHERE key='server.integrations'").get() as { value: string } | undefined)?.value

it('leaves the env untouched when nothing is saved', async () => {
  expect(await withIntegrations(env)).toBe(env)
})
it('stores values encrypted and fills them in', async () => {
  await updateIntegrations(env, { values: { EXA_API_KEY: 'exa-synthetic-key' } })
  expect(stored()).not.toContain('exa-synthetic-key')
  expect((await withIntegrations(env)).EXA_API_KEY).toBe('exa-synthetic-key')
  expect(env.EXA_API_KEY).toBeUndefined()
})
it('lets a deployment variable win', async () => {
  await updateIntegrations(env, { values: { EXA_API_KEY: 'saved-synthetic-key' } })
  expect((await withIntegrations({ ...env, EXA_API_KEY: 'deployment-key' })).EXA_API_KEY).toBe('deployment-key')
})
it('applies a save and a removal at once in this isolate', async () => {
  await updateIntegrations(env, { values: { EXA_API_KEY: 'first-synthetic-key' } })
  await withIntegrations(env)
  await updateIntegrations(env, { values: { EXA_API_KEY: 'second-synthetic-key' } })
  expect((await withIntegrations(env)).EXA_API_KEY).toBe('second-synthetic-key')
  await updateIntegrations(env, { values: { EXA_API_KEY: null } })
  expect((await withIntegrations(env)).EXA_API_KEY).toBeUndefined()
  expect(stored()).toBeUndefined()
})
it('keeps other settings when one changes', async () => {
  await updateIntegrations(env, { values: { EXA_API_KEY: 'exa-synthetic-key', BROWSER_CDP_URL: 'http://chromium:9222' } })
  await updateIntegrations(env, { values: { EXA_API_KEY: null } })
  expect(await loadSavedIntegrations(env)).toEqual({ BROWSER_CDP_URL: 'http://chromium:9222' })
})
it('ignores saved values it cannot decrypt, rather than failing every request', async () => {
  await updateIntegrations(env, { values: { EXA_API_KEY: 'exa-synthetic-key' } })
  expect(await loadSavedIntegrations({ ...env, AUTH_SECRET: 'another-secret-that-is-longer-than-32-chars' } as L4Env)).toEqual({})
})
it('does not break before the first migration', async () => {
  const broken = { ...env, DB: { prepare: () => { throw new Error('no such table') } } } as unknown as L4Env
  expect(await withIntegrations(broken)).toBe(broken)
})
it.each([
  [{ NOPE: 'value' }], [{ CLOUDFLARE_ACCOUNT_ID: 'short' }], [{ CLOUDFLARE_API_TOKEN: 'short' }], [{ MAIL_GATEWAY_URL: 'ftp://mail.example.com' }],
  [{ MAIL_GATEWAY_URL: 'https://user:secret@mail.example.com' }], [{ POSTMARK_INBOUND_SECRET: 'short' }], [{ SES_SNS_TOPIC_ARN: 'not-an-arn' }], [{ BROWSER_CDP_URL: 'nonsense' }],
  [{ AUTH_SECRET: secret32 }], [{ PUBLIC_ORIGIN: 'https://evil.example' }],
])('refuses %j', async values => {
  await expect(updateIntegrations(env, { values })).rejects.toMatchObject({ statusCode: 400 })
  expect(stored()).toBeUndefined()
})
it('reports sources, and never returns a secret', async () => {
  await updateIntegrations(env, { values: { EXA_API_KEY: 'exa-synthetic-key', SES_SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:llll', MAILGUN_WEBHOOK_SIGNING_KEY: secret32 } })
  const status = await integrationsStatus({ ...await withIntegrations(env), POSTMARK_INBOUND_SECRET: 'p'.repeat(40) } as L4Env, ids.owner, 'https://l4.example')
  expect(JSON.stringify(status)).not.toContain('exa-synthetic-key')
  expect(JSON.stringify(status)).not.toContain(secret32)
  expect(JSON.stringify(status)).not.toContain('pppp')
  expect(status.fields.EXA_API_KEY).toEqual({ source: 'settings', value: null })
  expect(status.fields.SES_SNS_TOPIC_ARN).toEqual({ source: 'settings', value: 'arn:aws:sns:us-east-1:123456789012:llll' })
  expect(status.fields.POSTMARK_INBOUND_SECRET).toEqual({ source: 'deployment', value: null })
  expect(status.fields.CLOUDFLARE_API_TOKEN?.source).toBeNull()
  expect(status.status.search).toBe('exa')
  expect(status.webhooks.postmark).toBe('https://l4.example/api/email/inbound/postmark')
})
it('reports a value saved by another isolate at once, past the cache', async () => {
  await withIntegrations(env)
  await saveOther()
  const status = await integrationsStatus(env, ids.owner, 'https://l4.example')
  expect(status.status.search).toBe('exa')
  expect(status.fields.EXA_API_KEY?.source).toBe('settings')
})
it('offers only web search on Cloudflare, where the rest comes from bindings', async () => {
  const status = await integrationsStatus({ ...f.env, LLLL_RUNTIME: 'workers' } as L4Env, ids.owner, 'https://l4.example')
  expect(status.cloudflareNetwork).toBe(true)
  expect(Object.keys(status.fields)).toEqual(['EXA_API_KEY'])
})

it.each([
  [{ isOwner: false, authorization: { principal: { kind: 'human' }, credential: { kind: 'session' } } }],
  [{ isOwner: true, authorization: { principal: { kind: 'human' }, credential: { kind: 'token' } } }],
  [{ isOwner: true, authorization: { principal: { kind: 'human' }, credential: { kind: 'session' }, delegation: { by: 'someone' } } }],
  [{ isOwner: true, authorization: { principal: { kind: 'agent' }, credential: { kind: 'session' } } }],
])('lets only a signed-in Owner change these: %j', member => {
  expect(() => requireIntegrationOwner(member)).toThrow()
})
it('accepts the signed-in Owner', () => {
  expect(() => requireIntegrationOwner({ isOwner: true, authorization: { principal: { kind: 'human' }, credential: { kind: 'session' } } })).not.toThrow()
})

it('turns page reading and web search on for Agents without an env variable', async () => {
  f.db.prepare("UPDATE project_policies SET permissions_bitmask=permissions_bitmask|? WHERE id='fixture-agent'").run(Permission.browseWeb)
  const context = await f.run()
  const names = async () => (await toolsForRun(env, context.authorization, () => {}, context.run)).catalog().then(tools => tools.map(tool => tool.name))
  expect(browserProvider(env)).toBeNull()
  expect(await names()).not.toContain('read_url')
  expect(await names()).not.toContain('search_web')
  await saveIntegrations(env, { BROWSER_CDP_URL: 'http://chromium:9222', EXA_API_KEY: 'exa-synthetic-key' })
  expect(browserProvider(await withIntegrations(env))).toBe('cdp')
  expect(await names()).toEqual(expect.arrayContaining(['read_url', 'search_web']))
})
it('searches with the saved Exa key', async () => {
  const network = vi.fn(async () => Response.json({ results: [{ url: 'https://example.com/', title: 'Result', text: 'Body' }] }))
  vi.stubGlobal('fetch', network)
  await saveIntegrations(env, { EXA_API_KEY: 'exa-synthetic-key' })
  const result = await searchWeb(await withIntegrations(env), 'query')
  expect(result.results[0]?.url).toBe('https://example.com/')
  expect(new Headers((network.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('x-api-key')).toBe('exa-synthetic-key')
})
it('sends mail through a saved gateway', async () => {
  const network = vi.fn(async () => Response.json({ messageId: 'sent-1' }))
  vi.stubGlobal('fetch', network)
  await saveIntegrations(env, { MAIL_GATEWAY_URL: 'https://mail.example.com/send', MAIL_GATEWAY_TOKEN: 'gateway-token' })
  const effective = await withIntegrations(env)
  expect(serverEmailProvider(env)).toBeNull()
  expect(serverEmailProvider(effective)).toBe('gateway')
  await expect(sendServerEmail(effective, { from: 'a@example.com', to: 'b@example.com', subject: 'Hi', text: 'Hi' } as Parameters<typeof sendServerEmail>[1])).resolves.toMatchObject({ messageId: 'sent-1' })
  expect(new Headers((network.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('Authorization')).toBe('Bearer gateway-token')
})
it('checks incoming mail against a saved secret', async () => {
  await saveIntegrations(env, { POSTMARK_INBOUND_SECRET: secret32 })
  const effective = await withIntegrations(env)
  expect(emailInboundProvider(env)).toBeNull()
  expect(emailInboundProvider(effective)).toBe('postmark')
  const wrong = new Request('https://l4.example/api/email/inbound/postmark', { method: 'POST', headers: { Authorization: `Basic ${btoa('postmark:wrong')}` }, body: '{}' })
  expect((await acceptPostmarkInbound(wrong, effective)).status).toBe(401)
  const right = new Request('https://l4.example/api/email/inbound/postmark', { method: 'POST', headers: { Authorization: `Basic ${btoa(`postmark:${secret32}`)}` }, body: '{}' })
  expect((await acceptPostmarkInbound(right, effective)).status).not.toBe(401)
})
it('runs Live on a saved Cloudflare account outside Cloudflare', async () => {
  await saveIntegrations(env, { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 't'.repeat(40) })
  expect(callsProvider(env)).toBe('realtimekit')
  expect(callsProvider(await withIntegrations(env))).toBe('realtimekit-rest')
})
