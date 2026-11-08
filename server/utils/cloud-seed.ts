import { and, eq } from 'drizzle-orm'
import { agents, roles, spaceMembers, users } from '../../drizzle/schema'
import { cloudSeedSchema, seedTokenScopes, type CloudSeed, type MemberIdentity, type SeedAgent } from '../../shared/cloud-seed'
import { encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { newId, nowIso } from '../../shared/ids'
import { MCP_DEFAULT_TOKEN_SCOPES } from '../../shared/mcp'
import { Permission } from '../../shared/permissions'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import { signalMembersChanged } from '../../workers/member-events'
import type { L4Env } from '../../workers/env'
import { agentProviderCatalog } from './agent-providers'
import { fail } from './cf'
import { getDb } from './db'
import { recordMemberIdentity } from './member-identities'
import { assertAgentNameAvailable } from './member-names'
import { writeAudit } from './messages'

/**
 * The seed L4 Cloud left on this Server (ADR 0012): what the first claim creates besides the Owner. It is read
 * once, by the claim, and goes with the `server_setup` row. Everything it names is created by the Owner, as the
 * Owner would from the interface: an Agent under a system Role with a token the Agent already holds, and the
 * partner's secrets and env for Projects the partner later creates.
 */
export const PARTNER_SETTING = 'cloud.partner'
const SEED_AGENT_SETTING = 'cloud.agent'
const partnerSecretScope = (name: string) => `cloud-partner-secret:${name}`

export type StoredPartnerConfig = {
  secrets: Record<string, { secret: EncryptedSecret; hosts: string[] }>
  env: Record<string, string>
  updatedAt: string
}

/** The seed as `server_setup` holds it, or null when there is none or it does not parse. */
export async function readCloudSeed(db: D1Database): Promise<CloudSeed | null> {
  const row = await db.prepare('SELECT seed_json AS seedJson FROM server_setup WHERE singleton = 1').first<{ seedJson: string | null }>()
  if (!row?.seedJson) return null
  try {
    const parsed = cloudSeedSchema.safeParse(JSON.parse(row.seedJson))
    return parsed.success ? parsed.data : null
  }
  catch {
    return null
  }
}

/** The Owner has just been created: the seed's identity, Agent, secrets and env follow, each as the Owner would make it. */
export async function applyCloudSeed(env: L4Env, input: { serverId: string; ownerId: string; seed: CloudSeed }) {
  const { seed } = input
  if (seed.owner?.identity) await recordMemberIdentity(env, seed.owner.identity, input.ownerId)
  const agent = seed.agent ? await upsertSeedAgent(env, { serverId: input.serverId, ownerId: input.ownerId, agent: seed.agent }) : null
  if (Object.keys(seed.secrets).length || Object.keys(seed.env).length) await storePartnerConfig(env, { secrets: seed.secrets, env: seed.env })
  return { agentId: agent?.agentId ?? null }
}

/** Which Agent each seeded name became, and the instructions version it holds: how `agents/upsert` finds it again after a rename. */
type StoredSeedAgents = Record<string, { userId: string; version: number }>

async function storedSeedAgents(env: L4Env): Promise<StoredSeedAgents> {
  const value = await readServerSetting(env.DB, SEED_AGENT_SETTING)
  if (!value) return {}
  try { return JSON.parse(value) as StoredSeedAgents } catch { return {} }
}

async function rememberSeedAgent(env: L4Env, name: string, record: StoredSeedAgents[string]) {
  await writeServerSetting(env.DB, SEED_AGENT_SETTING, JSON.stringify({ ...await storedSeedAgents(env), [name]: record }))
}

/** The key of the Role a seeded Agent gets for `admin`, and its name. */
export const CLOUD_AGENT_ROLE = { key: 'cloud-agent', name: 'Cloud agent' } as const
/** What an Agent needs beyond `admin` to connect with its token and do the work it is asked to do. */
const AGENT_WORK_PERMISSIONS = Permission.mcpConnect | Permission.executeTasks | Permission.useComputer | Permission.manageSchedules | Permission.proposeCode

/**
 * The Role a seeded Agent gets. The system Role `admin` cannot connect over MCP, on purpose, so an Agent the seed
 * puts under `admin` gets **Cloud agent**: admin's permissions plus what an Agent needs to connect and work, made
 * once on first use and the Owner's to change. Any other key names a Role as it is.
 */
async function seedAgentRole(env: L4Env, key: string) {
  const db = getDb(env.DB)
  const named = (await db.select().from(roles).where(eq(roles.key, key === 'admin' ? CLOUD_AGENT_ROLE.key : key)).limit(1))[0]
  if (named) return named
  if (key !== 'admin') fail(400, 'role_unknown', `This Server has no Role "${key}"`)
  const admin = (await db.select().from(roles).where(eq(roles.key, 'admin')).limit(1))[0]
  if (!admin) fail(409, 'server_incomplete', 'Admin role not found')
  const now = nowIso()
  const role = { id: newId(), key: CLOUD_AGENT_ROLE.key, name: CLOUD_AGENT_ROLE.name, permissionsBitmask: admin.permissionsBitmask | AGENT_WORK_PERMISSIONS, resourceAccessJson: '{}', position: admin.position + 1, isSystem: false, mentionable: false, createdAt: now, updatedAt: now }
  await db.insert(roles).values(role).onConflictDoNothing()
  return (await db.select().from(roles).where(eq(roles.key, CLOUD_AGENT_ROLE.key)).limit(1))[0]!
}

/**
 * The seed's Agent, by name: created if missing, with the Role the seed names and the pre-hashed token the Agent
 * already holds, created by the Owner and acting as the Agent. Found again by the id this Server recorded for that
 * name, or by name when nothing was recorded. Instructions are replaced only when `version` grows; the token is
 * written only on creation, and never twice.
 */
export async function upsertSeedAgent(env: L4Env, input: { serverId: string; ownerId: string; agent: Omit<SeedAgent, 'token'> & { token?: SeedAgent['token'] } }) {
  const { agent } = input
  const db = getDb(env.DB)
  const owner = (await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.ownerId), eq(users.status, 'active'))).limit(1))[0]
  if (!owner) fail(409, 'owner_missing', 'The Server has no Owner yet')
  const stored = (await storedSeedAgents(env))[agent.name]
  let existing = stored
    ? (await db.select({ id: users.id }).from(users).where(and(eq(users.id, stored.userId), eq(users.kind, 'agent'), eq(users.status, 'active'))).limit(1))[0]
    : undefined
  existing ??= (await db.select({ id: users.id }).from(users).where(and(eq(users.displayName, agent.name), eq(users.kind, 'agent'), eq(users.status, 'active'))).limit(1))[0]
  const now = nowIso()
  if (existing) {
    const version = stored?.userId === existing.id ? stored.version : 0
    if (agent.version > version) {
      await db.update(agents).set({ instructions: agent.instructions, updatedAt: now }).where(eq(agents.userId, existing.id))
      await rememberSeedAgent(env, agent.name, { userId: existing.id, version: agent.version })
    }
    return { agentId: existing.id, created: false }
  }

  const role = await seedAgentRole(env, agent.role)
  await assertAgentNameAvailable(env, agent.name)
  const id = newId()
  const model = (await agentProviderCatalog(env)).defaultModel || ''
  await db.batch([
    db.insert(users).values({ id, kind: 'agent', handle: null, displayName: agent.name, avatarR2Key: null, status: 'active', roleId: role.id, nickname: null, joinedAt: now, createdAt: now, updatedAt: now }),
    db.insert(agents).values({ userId: id, harness: 'pi', model, instructions: agent.instructions, status: 'active', createdBy: input.ownerId, lastActiveAt: null, createdAt: now, updatedAt: now }),
    db.insert(spaceMembers).values({ spaceId: DEFAULT_SPACE_ID, userId: id, joinedAt: now }).onConflictDoNothing(),
  ])
  await writeAudit(env, { serverId: input.serverId, actorId: input.ownerId, action: 'agent.create', targetType: 'agent', targetId: id, meta: { displayName: agent.name, model, role: role.key, seed: true } })
  if (agent.token) await writeSeedToken(env, { serverId: input.serverId, ownerId: input.ownerId, agentId: id, name: agent.name, token: agent.token })
  await rememberSeedAgent(env, agent.name, { userId: id, version: agent.version })
  await signalMembersChanged(env, input.serverId)
  return { agentId: id, created: true }
}

/** The token the seed's Agent already holds, as User Settings → Connections → Tokens would record one the Owner made for it. */
async function writeSeedToken(env: L4Env, input: { serverId: string; ownerId: string; agentId: string; name: string; token: SeedAgent['token'] }) {
  const known = await env.DB.prepare('SELECT id FROM mcp_access_tokens WHERE token_hash = ?').bind(input.token.hash).first<{ id: string }>()
  if (known) return known.id
  const scopes = seedTokenScopes(input.token.scopes)
  const id = newId()
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO mcp_access_tokens (id, name, token_hash, token_prefix, scopes_json, subject_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, `${input.name} on L4 Cloud`.slice(0, 80), input.token.hash, input.token.prefix.slice(0, 14), JSON.stringify(scopes.length ? scopes : MCP_DEFAULT_TOKEN_SCOPES), input.agentId, input.ownerId, now, now).run()
  await writeAudit(env, { serverId: input.serverId, actorId: input.ownerId, action: 'mcp_token.create', targetType: 'mcp_token', targetId: id, meta: { name: input.name, scopes, subjectId: input.agentId, seed: true } })
  return id
}

/**
 * The partner's secrets and env for Projects it later creates, kept encrypted under one setting. A later call
 * replaces the set; nothing is applied to a Project that exists, and no value is ever read back out.
 */
export async function storePartnerConfig(env: L4Env, input: { secrets: Record<string, { value: string; hosts: string[] }>; env: Record<string, string> }) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const secrets: StoredPartnerConfig['secrets'] = {}
  for (const [name, entry] of Object.entries(input.secrets)) {
    secrets[name] = { secret: await encryptSecret(env.AUTH_SECRET, partnerSecretScope(name), entry.value), hosts: entry.hosts }
  }
  const stored: StoredPartnerConfig = { secrets, env: input.env, updatedAt: nowIso() }
  await writeServerSetting(env.DB, PARTNER_SETTING, JSON.stringify(stored))
  return { secrets: Object.keys(secrets).length, env: Object.keys(input.env).length }
}

/** What the partner left for later Projects, without any secret value: the names, their hosts and the env. */
export async function readPartnerConfig(env: L4Env): Promise<{ secrets: Record<string, { hosts: string[] }>; env: Record<string, string> } | null> {
  const value = await readServerSetting(env.DB, PARTNER_SETTING)
  if (!value) return null
  try {
    const stored = JSON.parse(value) as StoredPartnerConfig
    return { secrets: Object.fromEntries(Object.entries(stored.secrets).map(([name, entry]) => [name, { hosts: entry.hosts }])), env: stored.env }
  }
  catch {
    return null
  }
}

export type { CloudSeed, MemberIdentity }
