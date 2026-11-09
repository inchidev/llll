import { z } from 'zod'
import { cloudSeedSchema, memberIdentitySchema, partnerEnvSchema, partnerSecretsSchema, seedAgentSchema } from '../../shared/cloud-seed'
import { agentModelRef } from '../../shared/agent-providers'
import { fileStorage } from '../../shared/file-storage'
import { isUsername } from '../../shared/account'
import { newId } from '../../shared/ids'
import { getServerId } from '../../shared/server-id'
import { isCloudHosted } from '../../shared/server-runtime'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'
import { generatedUsername } from './account-identity'
import { discoverAgentModels } from './agent-provider-models'
import { saveAgentProvider } from './agent-providers'
import { provisionServerWithEnv } from './bootstrap'
import { partnerAction } from './cloud-partner'
import { applyCloudSeed, readCloudSeed, storePartnerConfig, upsertSeedAgent } from './cloud-seed'
import { getDb, serverReady } from './db'
import { releaseL4Boxes } from './l4-compute'
import { findMemberByIdentity, removePartnerMember, upsertPartnerMember } from './member-identities'
import { ensureServerMailFromEnv } from './server-mail'
import { mintSignInLink } from './signin-link'

/**
 * What L4 Cloud asks of a hosted Server, under `/.llll/cloud/`, with the Server's own `CLOUD_SECRET` as a bearer
 * token: run the scheduled work (user Workers may get no Cron Trigger of their own), empty the files bucket before
 * the control plane deletes it, and the partner and agent doors of ADR 0012: claim the Owner, keep a partner's
 * Members, sign one in, keep its Agent, secrets and models, and put the Server to sleep; and the partner's game
 * doors (`projects/*`, `tasks/*` in `cloud-partner.ts`), which act as the Member an identity names. Only a Server with
 * `LLLL_RUNTIME=cloud` and a secret answers; everything else is 404, so that the paths say nothing on any other
 * Server. Every action is idempotent and answers `{ ok: true, … }` or `{ error }` with a 4xx.
 */
export const CLOUD_RELAY_PREFIX = '/.llll/cloud/'

// Compared as digests of equal length, byte by byte without an early exit, so that timing says nothing about the secret.
async function sameSecret(given: string, expected: string) {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(a), right = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

async function authorized(request: Request, env: L4Env) {
  const secret = env.CLOUD_SECRET?.trim()
  if (!isCloudHosted(env) || !secret || secret.length < 16) return false
  const header = request.headers.get('authorization') || ''
  const given = /^Bearer\s+(\S+)$/iu.exec(header)?.[1]
  return Boolean(given) && sameSecret(given!, secret)
}

/** Deletes every object in the files bucket, so that the bucket can be deleted. Returns how many went. */
export async function purgeServerFiles(env: L4Env) {
  if (!env.FILES) return 0
  const store = fileStorage(env)
  let deleted = 0
  let cursor: string | undefined
  do {
    const page = await store.list({ limit: 500, cursor })
    const keys = page.objects.map(object => object.key)
    if (keys.length) { await store.delete(keys); deleted += keys.length }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return deleted
}

class RelayRefusal extends Error {
  constructor(public status: number, message: string) { super(message) }
}
const refuse = (status: number, message: string): never => { throw new RelayRefusal(status, message) }

/** The Owner, or a refusal: every action after the claim acts as the Owner would. */
async function requireOwner(env: L4Env) {
  const row = await env.DB.prepare('SELECT owner_id AS ownerId FROM server LIMIT 1').first<{ ownerId: string }>()
  if (!row) refuse(409, 'This Server has no Owner yet. Claim the Owner first.')
  return row!.ownerId
}

const identityBody = z.object({ identity: memberIdentitySchema }).strict()
const upsertMemberBody = z.object({ identity: memberIdentitySchema, name: z.string().trim().min(1).max(80), role: z.literal('member').default('member') }).strict()
const upsertAgentBody = seedAgentSchema
const secretsBody = z.object({ secrets: partnerSecretsSchema, env: partnerEnvSchema }).strict()
const modelsBody = z.object({ provider: z.literal('openrouter'), key: z.string().trim().min(1).max(4096) }).strict()

/**
 * Only on a Server whose seed names the Owner's identity and whose Owner does not exist yet: the same bootstrap
 * as `/api/setup/owner`, with a password nobody is told, then the identity, the seed's Agent, secrets and env.
 * A second call answers the same Owner.
 */
async function claimOwner(env: L4Env) {
  const serverId = await getServerId(env.DB)
  const seed = await readCloudSeed(env.DB)
  if (await serverReady(env.DB)) {
    const ownerId = await requireOwner(env)
    if (seed?.owner?.identity) {
      const member = await findMemberByIdentity(env, seed.owner.identity)
      if (member && member.id !== ownerId) refuse(409, 'This Server already has an Owner')
    }
    return { ok: true as const, ownerId }
  }
  const identity = seed?.owner?.identity
  if (!identity) refuse(409, 'This Server is claimed by a person at /setup, not through L4 Cloud')
  const setup = await env.DB.prepare('SELECT server_name AS serverName FROM server_setup WHERE singleton = 1').first<{ serverName: string }>()
  const db = getDb(env.DB)
  const wanted = seed!.owner?.username?.trim().toLowerCase() || ''
  const username = isUsername(wanted) ? wanted : await generatedUsername(db, seed!.owner?.name || wanted || 'owner')
  const displayName = seed!.owner?.name?.trim() || username
  const password = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const userId = newId()
  try {
    await provisionServerWithEnv(env, { userId, username, password, handle: username, displayName, serverName: setup?.serverName || 'L4' })
  }
  catch (error) {
    // Two claims at once: the second finds the first's Owner.
    if (!await serverReady(env.DB)) throw error
  }
  await ensureServerMailFromEnv(env)
  const ownerId = await requireOwner(env)
  await applyCloudSeed(env, { serverId, ownerId, seed: seed! })
  await env.DB.prepare('DELETE FROM server_setup WHERE singleton = 1').run()
  return { ok: true as const, ownerId }
}

/**
 * The model a partner's Agent starts with. OpenRouter lists its newest models first, small ones included, so the first
 * tool-capable one can be a 2B model that cannot write a game. These families are tried in order, each by the first of
 * its models the provider lists (its newest): Sonnet before the dearer Opus, GPT-5 but not its mini or nano; free and
 * batch variants are left out. It is always among the models kept. The Owner can choose another in Settings.
 */
export const PREFERRED_AGENT_MODELS = [
  /^anthropic\/claude-sonnet/u, /^openai\/gpt-5(?!.*(?:nano|mini))/u, /^google\/gemini-[\d.]+-pro/u,
  /^qwen\/qwen3-coder/u, /^moonshotai\/kimi-k2/u, /^deepseek\/deepseek-(?:chat|v3|r1)/u,
]
export function preferredModel<T extends { id: string }>(models: readonly T[]) {
  for (const family of PREFERRED_AGENT_MODELS) {
    // Free variants are rate-limited and batch ones answer later: neither can hold a conversation with a creator.
    const found = models.find(model => family.test(model.id) && !/(?::free|batch)/u.test(model.id))
    if (found) return found
  }
  return null
}

async function setModels(env: L4Env, body: z.infer<typeof modelsBody>) {
  const models = await discoverAgentModels(body.provider, body.key)
  if (!models.length) refuse(502, 'The provider listed no models')
  const usable = models.filter(model => model.tools !== false)
  const preferred = preferredModel(usable)
  // The catalog is large; the first two hundred keep the default and every tool-capable model the provider lists first.
  const kept = [...(preferred ? [preferred] : []), ...usable.filter(model => model !== preferred), ...models.filter(model => model.tools === false)].slice(0, 200)
  await saveAgentProvider(env, body.provider, { kind: body.provider, enabled: true, webSearch: false, apiKey: body.key, models: kept })
  const chosen = preferred ?? usable[0] ?? kept[0]
  if (await readServerSetting(env.DB, 'agents.defaultModel') === null && chosen) {
    await writeServerSetting(env.DB, 'agents.defaultModel', agentModelRef(body.provider, chosen.id))
  }
  return { ok: true as const, configured: true as const, models: kept.length }
}

/** Every box of this Server on L4 Compute is released; the script's deletion is the control plane's. */
async function sleep(env: L4Env) {
  const rows = await env.DB.prepare(`SELECT b.id FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id
    WHERE b.status<>'released' AND (n.placement_id IS NOT NULL OR json_extract(n.capabilities_json,'$.provider')='l4-compute')`).all<{ id: string }>()
  const released = await releaseL4Boxes(env, rows.results.map(row => row.id))
  return { ok: true as const, released: released.length }
}

type Schedule = (promise: Promise<unknown>) => void

async function act(env: L4Env, action: string, body: unknown, scheduled: (env: L4Env) => Promise<void>, schedule: Schedule): Promise<Record<string, unknown> | null> {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/u, '') || ''
  switch (action) {
    case 'scheduled': await scheduled(env); return { ok: true }
    case 'purge-files': return { ok: true, deleted: await purgeServerFiles(env) }
    case 'claim-owner': return claimOwner(env)
    case 'members/upsert': {
      const input = upsertMemberBody.parse(body)
      const [serverId, actorId] = [await getServerId(env.DB), await requireOwner(env)]
      const member = await upsertPartnerMember(env, { serverId, actorId, identity: input.identity, name: input.name })
      return { ok: true, userId: member.userId, created: member.created }
    }
    case 'members/remove': {
      const input = identityBody.parse(body)
      const [serverId, actorId] = [await getServerId(env.DB), await requireOwner(env)]
      const result = await removePartnerMember(env, { serverId, actorId, identity: input.identity })
      return { ok: true, userId: result.userId, removed: result.removed }
    }
    case 'session-link': {
      const input = identityBody.parse(body)
      await requireOwner(env)
      const member = await findMemberByIdentity(env, input.identity)
      if (!member || member.status !== 'active' || member.kind !== 'human') refuse(404, 'No Member has this identity')
      if (!origin) refuse(503, 'This Server has no public origin')
      const link = await mintSignInLink(env, member!.id, origin)
      return { ok: true, url: link.url, expiresAt: link.expiresAt }
    }
    case 'agents/upsert': {
      const input = upsertAgentBody.parse(body)
      const [serverId, ownerId] = [await getServerId(env.DB), await requireOwner(env)]
      const agent = await upsertSeedAgent(env, { serverId, ownerId, agent: input })
      return { ok: true, agentId: agent.agentId, created: agent.created }
    }
    case 'secrets/set': {
      const input = secretsBody.parse(body)
      const stored = await storePartnerConfig(env, { secrets: input.secrets, env: input.env })
      return { ok: true, secrets: stored.secrets, env: stored.env }
    }
    case 'models/set': return setModels(env, modelsBody.parse(body))
    case 'sleep': return sleep(env)
    case 'projects/create': case 'projects/get': case 'tasks/create': case 'tasks/get': case 'tasks/message':
      await requireOwner(env)
      return partnerAction(env, action, body, schedule)
    default: return null
  }
}

/** A refusal's status and sentence, from this file's own refusals, `fail()` and zod; anything else is a fault. */
function refusal(error: unknown): { status: number; message: string } | null {
  if (error instanceof RelayRefusal) return { status: error.status, message: error.message }
  if (error instanceof z.ZodError) return { status: 400, message: `Invalid request: ${error.issues[0]?.path.join('.') || 'body'}` }
  const typed = error as { statusCode?: number; statusMessage?: string; data?: { error?: { message?: string } } } | null
  if (typed?.statusCode && typed.statusCode >= 400 && typed.statusCode < 600) return { status: typed.statusCode, message: typed.data?.error?.message || typed.statusMessage || 'Refused' }
  return null
}

/**
 * `schedule` keeps work going after the answer (the Worker's `waitUntil`): L4 Cloud's partner waits only seconds,
 * so a Task's files and its Agent's start come after the Task is answered.
 */
export async function cloudRelay(request: Request, env: L4Env, pathname: string, scheduled: (env: L4Env) => Promise<void>,
  schedule: Schedule = promise => { void promise.catch(error => console.error('cloud-relay.background_failed', { error: error instanceof Error ? error.message : String(error) })) }): Promise<Response | null> {
  if (!pathname.startsWith(CLOUD_RELAY_PREFIX)) return null
  if (request.method !== 'POST' || !(await authorized(request, env))) return new Response('Not found', { status: 404 })
  const action = pathname.slice(CLOUD_RELAY_PREFIX.length)
  const text = await request.text()
  let body: unknown = {}
  if (text.trim()) {
    try { body = JSON.parse(text) } catch { return Response.json({ error: 'Invalid request: body is not JSON' }, { status: 400 }) }
  }
  try {
    const answer = await act(env, action, body, scheduled, schedule)
    return answer ? Response.json(answer) : new Response('Not found', { status: 404 })
  }
  catch (error) {
    const refused = refusal(error)
    if (refused) return Response.json({ error: refused.message }, { status: refused.status })
    console.error('cloud-relay.failed', { action, error: error instanceof Error ? error.message : String(error) })
    return Response.json({ error: 'The Server could not complete this action' }, { status: 500 })
  }
}

/** Keeps the seed's shape in one place for callers that read `seed_json` without the Server's helpers. */
export { cloudSeedSchema }
