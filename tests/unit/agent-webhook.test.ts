import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createAgentRun } from '../../server/utils/agent-run-service'
import { agentWebhook, completeExternalRun, completeExternalRunOnReply, saveAgentWebhook } from '../../server/utils/agent-webhooks'
import { publicWebhookUrl } from '../../shared/agent-webhooks'
import { AgentRunDurableObject } from '../../workers/agent-run-do'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {
  constructor(protected ctx: unknown, protected env: unknown) {}
} }))
vi.mock('../../workers/agent-pi-durable', () => ({ runEmbeddedPi: vi.fn() }))

let db: DatabaseSync, env: L4Env
const agentId = '00000000-0000-4000-8000-000000000002'
const post = vi.fn(async () => ({ id: 'note', channelId: 'public-chat' }))
const hook = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }))
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('fetch', hook)
  post.mockClear(); hook.mockClear()
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES('owner-role','owner','Owner',0,'{}'),
    ('agent-role','custom:agent','Researcher',${Permission.sendMessages | Permission.readMessages},'{}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner-user','human','John','active','owner-role','2026-10-21'),
    ('${agentId}','agent','Grok','active','agent-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','L4','owner-user');
    INSERT INTO agents(user_id,created_by,harness,model) VALUES('${agentId}','owner-user','pi','');
    INSERT INTO channels(id,name,type,visibility) VALUES('public-chat','General','text','server');`)
  env = { DB: d1(db), AUTH_SECRET: 'test-server-secret-with-32-characters', PUBLIC_ORIGIN: 'https://team.example',
    AGENT_RUN_DO: { getByName: () => ({ wake: async () => {} }) },
    SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) },
    CHANNEL_DO: { getByName: () => ({ postAgentMessage: post, fanout: async () => {} }) },
  } as unknown as L4Env
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close() })

async function externalRun() {
  await saveAgentWebhook(env, agentId, 'owner-user', { url: 'https://hooks.grok.example/routine/abc', headerValue: 'Bearer sender-key' })
  const actor = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  return createAgentRun(env, actor, { agentId, channelId: 'public-chat', prompt: 'What does X say about L4?', idempotencyKey: 'mention-1' })
}
function coordinator(id: string) {
  const data = new Map<string, unknown>([['runId', id]])
  const ctx = { storage: { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value) }, setAlarm: async () => {}, deleteAlarm: async () => {} },
    waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) } }
  return { data, run: new AgentRunDurableObject(ctx as unknown as DurableObjectState, env) }
}

it('admits an external Agent without any model provider and wakes it once with an untrusted prompt', async () => {
  const run = await externalRun()
  expect(run.status).toBe('queued')
  expect(run.model).toBe('external')
  const { data, run: coordinatorRun } = coordinator(run.id)
  await coordinatorRun.alarm()
  await coordinatorRun.alarm()
  expect(hook).toHaveBeenCalledTimes(1)
  const [url, init] = hook.mock.calls[0]!
  expect(url).toBe('https://hooks.grok.example/routine/abc')
  expect(init.redirect).toBe('manual')
  const headers = new Headers(init.headers)
  expect(headers.get('Authorization')).toBe('Bearer sender-key')
  expect(headers.get('Idempotency-Key')).toBe(run.id)
  expect(JSON.parse(String(init.body))).toMatchObject({ type: 'agent.run', runId: run.id, prompt: 'What does X say about L4?',
    server: { mcp: 'https://team.example/mcp' }, agent: { name: 'Grok' }, from: { name: 'John' }, reply: { tool: 'send_message', arguments: { channelId: 'public-chat' } }, complete: { tool: 'complete_run', arguments: { runId: run.id } } })
  expect(data.get('webhookSentAt')).toEqual(expect.any(String))
})

it('keeps the Run open through progress messages until the Agent completes it', async () => {
  const run = await externalRun()
  const { run: coordinatorRun } = coordinator(run.id)
  await coordinatorRun.alarm()
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
  db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('progress','public-chat',?,'Searching X…',?)").run(agentId, later(1))
  await coordinatorRun.alarm()
  expect(db.prepare('SELECT status FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'running' })
  db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('answer','public-chat',?,'Mostly praise.',?)").run(agentId, later(2))
  const agent = (await loadAuthorizationContext(env, { principalId: agentId, credential: { kind: 'mcp', id: 'token', scopes: ['messages:write'] }, delegatedBy: 'owner-user' }))!
  const human = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  await expect(completeExternalRun(env, human, { runId: run.id, outcome: 'completed' })).rejects.toMatchObject({ statusCode: 404 })
  expect(await completeExternalRun(env, agent, { runId: run.id, outcome: 'completed' })).toMatchObject({ changed: true })
  await coordinatorRun.alarm()
  expect(db.prepare('SELECT status,result_text,result_message_id FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'completed', result_text: 'Mostly praise.', result_message_id: 'answer' })
  expect(post).not.toHaveBeenCalled()
})

it('closes the Run when the Agent replies to the message that woke it', async () => {
  db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('mention-msg','public-chat','owner-user','@Grok hi',?)").run(new Date().toISOString())
  await saveAgentWebhook(env, agentId, 'owner-user', { url: 'https://hooks.grok.example/routine/abc', headerValue: 'Bearer sender-key' })
  const owner = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  const run = await createAgentRun(env, owner, { agentId, channelId: 'public-chat', sourceMessageId: 'mention-msg', prompt: 'hi', idempotencyKey: 'mention-2' })
  const { run: coordinatorRun } = coordinator(run.id)
  await coordinatorRun.alarm()
  expect(JSON.parse(String(hook.mock.calls[0]![1].body))).toMatchObject({ reply: { arguments: { channelId: 'public-chat', replyToId: 'mention-msg' } } })
  const agent = (await loadAuthorizationContext(env, { principalId: agentId, credential: { kind: 'mcp', id: 'token', scopes: ['messages:write'] }, delegatedBy: 'owner-user' }))!
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
  db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('progress','public-chat',?,'Looking…',?)").run(agentId, later(1))
  expect(await completeExternalRunOnReply(env, agent, { channelId: 'public-chat' })).toBeNull()
  expect(await completeExternalRunOnReply(env, owner, { channelId: 'public-chat', replyToId: 'mention-msg' })).toBeNull()
  expect(db.prepare('SELECT status FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'running' })
  db.prepare("INSERT INTO messages(id,channel_id,author_id,content,reply_to_id,created_at) VALUES('answer','public-chat',?,'Hello!','mention-msg',?)").run(agentId, later(2))
  expect(await completeExternalRunOnReply(env, agent, { channelId: 'public-chat', replyToId: 'mention-msg' })).toMatchObject({ changed: true })
  expect(db.prepare('SELECT status,result_message_id FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'completed', result_message_id: 'answer' })
})

it('settles at the reply timeout from what the Agent posted', async () => {
  const replied = await externalRun()
  const first = coordinator(replied.id)
  await first.run.alarm()
  db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('late','public-chat',?,'Here it is.',?)").run(agentId, new Date(Date.now() + 1000).toISOString())
  db.prepare("UPDATE agent_runs SET deadline='2000-01-01T00:00:00.000Z' WHERE id=?").run(replied.id)
  await first.run.alarm()
  expect(db.prepare('SELECT status,result_message_id FROM agent_runs WHERE id=?').get(replied.id)).toMatchObject({ status: 'completed', result_message_id: 'late' })
  expect(post).not.toHaveBeenCalled()

  db.exec("INSERT INTO channels(id,name,type,visibility) VALUES('quiet-chat','Quiet','text','server')")
  const actor = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  const silent = await createAgentRun(env, actor, { agentId, channelId: 'quiet-chat', prompt: 'Anyone?', idempotencyKey: 'mention-2' })
  const second = coordinator(silent.id)
  await second.run.alarm()
  db.prepare("UPDATE agent_runs SET deadline='2000-01-01T00:00:00.000Z' WHERE id=?").run(silent.id)
  await second.run.alarm()
  expect(db.prepare('SELECT status,last_error FROM agent_runs WHERE id=?').get(silent.id)).toMatchObject({ status: 'failed', last_error: expect.stringContaining('No reply arrived within 20 minutes') })
  expect(post).toHaveBeenCalledTimes(1)
})

it('fails visibly when the webhook rejects its key, without retrying', async () => {
  hook.mockResolvedValueOnce(new Response(null, { status: 401 }))
  const run = await externalRun()
  const { run: coordinatorRun } = coordinator(run.id)
  await coordinatorRun.alarm()
  await coordinatorRun.alarm()
  expect(hook).toHaveBeenCalledTimes(1)
  expect(db.prepare('SELECT status,last_error FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'failed', last_error: expect.stringContaining('401') })
  expect(post).toHaveBeenCalledTimes(1)
})

it('never sends a saved key to a new destination', async () => {
  await saveAgentWebhook(env, agentId, 'owner-user', { url: 'https://hooks.grok.example/a', headerValue: 'Bearer one' })
  await expect(saveAgentWebhook(env, agentId, 'owner-user', { url: 'https://elsewhere.example/a' })).rejects.toMatchObject({ statusCode: 400 })
  const saved = await agentWebhook(env, agentId)
  expect(saved?.url).toBe('https://hooks.grok.example/a')
  expect(saved?.credentialJson).not.toContain('Bearer one')
})

it('accepts only public https destinations', () => {
  expect(publicWebhookUrl('https://hooks.grok.example/x')).toBe(true)
  for (const url of ['http://hooks.grok.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://router.local/x', 'https://user:pass@hooks.example/x', 'https://intranet/x']) {
    expect(publicWebhookUrl(url)).toBe(false)
  }
})
