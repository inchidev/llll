import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { d1 } from '../helpers/sqlite-d1'
import { beginChatGPT, completeChatGPT, loadChatGPTAttempt, chatGPTAccessToken } from '../../server/utils/agent-chatgpt'
import { agentProviderCatalog, loadAgentProvider, resolveSavedAgentModel, saveAgentProvider, agentProviderKey, agentProviderScope, type ChatGPTCredentials } from '../../server/utils/agent-providers'
import { encryptSecret } from '../../shared/encrypted-secret'
import { writeServerSetting } from '../../shared/server-settings'
import { discoverAgentModels } from '../../server/utils/agent-provider-models'
import { chatGPTFetch } from '../../server/utils/chatgpt-transport'
import type { L4Env } from '../../workers/env'
let db: DatabaseSync, env: L4Env
const config = { kind: 'chatgpt' as const, name: 'Personal Codex', enabled: true, webSearch: false, models: [] }
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE server(owner_id TEXT); INSERT INTO server VALUES ('owner')")
  env = { DB: d1(db), AUTH_SECRET: 'test-auth-secret-for-this-server-only' } as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })
async function setup() {
  await saveAgentProvider(env, 'personal-codex', config)
  const attempt = await beginChatGPT(env, 'personal-codex', 'owner', 'http://localhost:3000', true)
  const pending = await loadChatGPTAttempt(env, attempt.state)
  const callback = new URL(attempt.redirectUri)
  callback.search = new URLSearchParams({ state: attempt.state, code: 'oauth-code', client_id: 'oaiapp_fixture' }).toString()
  return { attempt, pending, callback }
}
async function tokenFixture(nonce: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  const idToken = await new SignJWT({ nonce, email: 'fixture@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer('https://auth.openai.com').setAudience('oaiapp_fixture').setSubject('subject').setExpirationTime('5m').sign(privateKey)
  return { keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'fixture' }] }), idToken }
}
describe('ChatGPT account connection', () => {
  it('uses fresh PKCE and nonce but persists one host ID across named connections', async () => {
    const { attempt } = await setup()
    const next = await beginChatGPT(env, 'personal-codex', 'owner', 'http://localhost:3000', false)
    const a = new URL(attempt.authorizationUrl), b = new URL(next.authorizationUrl)
    expect(a.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(a.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/api/agent-auth/callback')
    expect(a.searchParams.get('ext_agent_host_id')).toBe(b.searchParams.get('ext_agent_host_id'))
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'))
    expect(JSON.stringify(attempt)).not.toContain('verifier')
    await expect(loadChatGPTAttempt(env, 'wrong')).rejects.toMatchObject({ statusCode: 400 })
  })
  it('validates signed identity, consumes state once, encrypts credentials, and scopes inference to the connecting member', async () => {
    const { attempt, pending, callback } = await setup()
    const { idToken, keySet } = await tokenFixture(pending.nonce)
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('code_verifier')).toBe(pending.verifier)
        expect(body.get('client_id')).toBe('oaiapp_fixture')
        return Response.json({ access_token: 'access-fixture', refresh_token: 'refresh-fixture', id_token: idToken, expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' })
      }
      return Response.json({ models: [{ slug: 'allowed-model', display_name: 'Allowed model', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hidden' }] })
    })
    vi.stubGlobal('fetch', fetcher)
    await completeChatGPT(env, callback, keySet)
    const stored = await loadAgentProvider(env, 'personal-codex')
    expect(JSON.stringify(stored)).not.toContain('access-fixture')
    expect(JSON.stringify(await agentProviderCatalog(env, { actorId: 'other' }))).not.toContain('Personal Codex')
    expect((await agentProviderCatalog(env, { actorId: 'owner' })).models[0]?.label).toBe('Allowed model')
    expect(await chatGPTAccessToken(env, 'personal-codex', 'owner')).toBe('access-fixture')
    await expect(resolveSavedAgentModel(env, 'l4:personal-codex:allowed-model', 'other')).rejects.toMatchObject({ statusCode: 403 })
    await expect(loadChatGPTAttempt(env, attempt.state)).rejects.toMatchObject({ statusCode: 400 })
    const reauth = new URL((await beginChatGPT(env, 'personal-codex', 'owner', 'http://localhost:3000', true)).authorizationUrl)
    expect(reauth.searchParams.get('client_id')).toBe('oaiapp_fixture')
    expect(reauth.searchParams.has('agent_name_hint')).toBe(false)
  })
  it.each(['nonce', 'scope', 'signature'] as const)('rejects a mismatched %s without saving tokens', async failure => {
    const { pending, callback } = await setup()
    const fixture = await tokenFixture(failure === 'nonce' ? 'other' : pending.nonce)
    const other = await tokenFixture(pending.nonce)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: fixture.idToken, expires_in: 3600, scope: failure === 'scope' ? 'openid' : 'chatgpt.tokens.use.direct' })))
    await expect(completeChatGPT(env, callback, failure === 'signature' ? other.keySet : fixture.keySet)).rejects.toThrow()
    expect((await loadAgentProvider(env, 'personal-codex'))?.secret).toBeUndefined()
  })
  it('renews using the issued client and retains rotated tokens encrypted', async () => {
    await saveAgentProvider(env, 'personal-codex', config)
    const credentials: ChatGPTCredentials = { accessToken: 'expired', refreshToken: 'old-refresh', idToken: 'id-token', expiresAt: 0, subject: 'subject', email: 'fixture@example.test', clientId: 'issued-client', scope: 'chatgpt.tokens.use.direct' }
    const provider = await loadAgentProvider(env, 'personal-codex')
    await writeServerSetting(env.DB, agentProviderKey('personal-codex'), JSON.stringify({ ...provider, connectedBy: 'owner', secret: await encryptSecret(env.AUTH_SECRET!, agentProviderScope('personal-codex'), JSON.stringify(credentials)) }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(new URLSearchParams(String(init.body)).get('client_id')).toBe('issued-client')
      return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 })
    }))
    expect(await chatGPTAccessToken(env, 'personal-codex', 'owner')).toBe('renewed')
    expect(await chatGPTAccessToken(env, 'personal-codex', 'owner')).toBe('renewed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await loadAgentProvider(env, 'personal-codex'))).not.toContain('rotated')
  })
})
it('discovers provider models and API families without asking for model IDs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'claude-model' }, { id: 'gpt-model' }, { id: 'kimi-model' }, { id: 'gemini-unsupported' }] })))
  expect((await discoverAgentModels('opencode')).map(m => m.api)).toEqual(['anthropic', 'responses', 'chat'])
})
it('uses the public ChatGPT plan contract and namespaces tools while preserving request history', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    expect(body.stream).toBe(true); expect(body.store).toBe(false)
    expect(body.max_output_tokens).toBeUndefined(); expect(body.temperature).toBeUndefined()
    expect(body.tools[0]).toMatchObject({ type: 'namespace', name: 'l4' })
    expect(body.input[0].namespace).toBe('l4')
    return new Response('data: [DONE]\n\n')
  }))
  await chatGPTFetch('https://api.openai.com/v1/responses', { body: JSON.stringify({ max_output_tokens: 50, temperature: 1, input: [{ type: 'function_call', name: 'list_tasks' }], tools: [{ type: 'function', name: 'list_tasks' }] }) })
})

it.each(['response.failed', 'response.incomplete', 'eof'])('does not publish a successful response on %s', async type => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(type === 'eof' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify({ type })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })))
  const response = await chatGPTFetch('https://api.openai.com/v1/responses', { body: '{}' })
  await expect(response.text()).rejects.toThrow()
})
