import { ensureFirstBoard } from './project-service'
import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission } from '../../shared/permissions'
import { spaceCreateSchema, spaceLimitsSchema, spaceMemberPatchSchema, spaceMemberSchema, spacePatchSchema, type SpaceDTO, type SpaceRole } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { signalMembersChanged } from '../../workers/member-events'
import { asRpc, fail } from './cf'
import type { ServerMembership } from './channel-access'
import { revalidateLiveRooms } from './live'
import { writeAudit } from './messages'
import { requireMemberQuota } from './space-quota'

type Row = { id: string; name: string; description: string; isDefault: number; suspendedAt: string | null; storageLimitBytes: number | null; memberLimit: number | null; agentLimit: number | null; monthlyRunLimit: number | null; monthlyEmailLimit: number | null; monthlyVoiceLimit: number | null; actionLimitsJson: string; role: SpaceRole | null; memberCount: number }
const COLUMNS = `s.id, s.name, s.description, s.is_default AS isDefault, s.suspended_at AS suspendedAt, s.monthly_voice_limit AS monthlyVoiceLimit, s.storage_limit_bytes AS storageLimitBytes, s.member_limit AS memberLimit, s.agent_limit AS agentLimit,
  s.monthly_run_limit AS monthlyRunLimit, s.monthly_email_limit AS monthlyEmailLimit, s.action_limits_json AS actionLimitsJson,
  (SELECT role FROM space_members m WHERE m.space_id = s.id AND m.user_id = ?1) AS role,
  (SELECT COUNT(*) FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = s.id AND u.kind = 'human') AS memberCount`

function toDto(row: Row, member: ServerMembership): SpaceDTO {
  const manages = member.isOwner || row.role === 'admin'
  return {
    id: row.id, name: row.name, description: row.description, isDefault: Boolean(row.isDefault), role: row.role, memberCount: Number(row.memberCount),
    ...(manages ? { quotas: { storageLimitBytes: row.storageLimitBytes, memberLimit: row.memberLimit, agentLimit: row.agentLimit, monthlyRunLimit: row.monthlyRunLimit, monthlyEmailLimit: row.monthlyEmailLimit, monthlyVoiceLimit: row.monthlyVoiceLimit } } : {}),
    suspended: Boolean(row.suspendedAt),
  }
}
async function load(env: L4Env, member: ServerMembership, spaceId: string): Promise<Row> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM spaces s WHERE s.id = ?2`).bind(member.user.id, spaceId).first<Row>()
  // A Space someone is outside of does not exist for them. Only the Owner can see them all.
  if (!row || (!member.isOwner && !row.role)) fail(404, 'not_found', 'Space not found')
  return row
}
function requireHuman(member: ServerMembership) {
  if (member.user.kind !== 'human' || member.authorization.credential.kind !== 'session') fail(403, 'forbidden', 'Spaces are managed by a person in a session')
}
/** The Owner or this Space's admin. Neither reads the Space's contents through this. */
export async function requireSpaceManager(env: L4Env, member: ServerMembership, spaceId: string): Promise<Row> {
  requireHuman(member)
  const row = await load(env, member, spaceId)
  if (!member.isOwner && row.role !== 'admin') fail(403, 'forbidden', 'Only this Space’s admin or the Server Owner can manage it')
  return row
}
function requireOwner(member: ServerMembership) {
  requireHuman(member)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the Server Owner can do this')
}

export async function listSpaces(env: L4Env, member: ServerMembership): Promise<SpaceDTO[]> {
  const rows = await env.DB.prepare(`SELECT ${COLUMNS} FROM spaces s ORDER BY s.is_default DESC, s.name, s.id`).bind(member.user.id).all<Row>()
  return (rows.results ?? []).filter(row => member.isOwner || row.role).map(row => toDto(row, member))
}

export async function createSpace(env: L4Env, member: ServerMembership, request: unknown): Promise<SpaceDTO> {
  requireHuman(member)
  if (!member.isOwner && !hasPermission(member.perms, Permission.manageServer)) fail(403, 'forbidden', 'Manage server is required to create a Space')
  const input = spaceCreateSchema.parse(request), id = newId(), now = nowIso()
  // A new Space opens with one channel and its creator as admin; an empty one has nothing to show.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO spaces(id, name, description, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(id, input.name, input.description, member.user.id, now),
    env.DB.prepare("INSERT INTO space_members(space_id, user_id, role, joined_at) SELECT ?1, ?2, 'admin', ?3").bind(id, member.user.id, now),
    env.DB.prepare("INSERT INTO channels(id, space_id, name, topic, type, visibility, position, created_by, created_at, updated_at) SELECT ?1, ?2, 'general', '', 'text', 'server', 0, ?3, ?4, ?4").bind(newId(), id, member.user.id, now),
  ])
  await ensureFirstBoard(env, id, member.user.id)
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.create', targetType: 'space', targetId: id, meta: { name: input.name } })
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.join', targetType: 'space', targetId: id, meta: { reason: 'created' } })
  return toDto(await load(env, member, id), member)
}

export async function updateSpace(env: L4Env, member: ServerMembership, spaceId: string, request: unknown): Promise<SpaceDTO> {
  const current = await requireSpaceManager(env, member, spaceId)
  const input = spacePatchSchema.parse(request)
  await env.DB.prepare('UPDATE spaces SET name = ?, description = ?, updated_at = ? WHERE id = ?')
    .bind(input.name ?? current.name, input.description ?? current.description, nowIso(), spaceId).run()
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.update', targetType: 'space', targetId: spaceId })
  return toDto(await load(env, member, spaceId), member)
}

export async function setSpaceLimits(env: L4Env, member: ServerMembership, spaceId: string, request: unknown): Promise<SpaceDTO> {
  requireOwner(member)
  const current = await load(env, member, spaceId)
  const input = spaceLimitsSchema.parse(request)
  if (input.reset) {
    await env.DB.prepare(`UPDATE spaces SET member_limit = NULL, action_limits_json = '{}', updated_at = ?, storage_limit_bytes = NULL, monthly_voice_limit = NULL, agent_limit = NULL, monthly_run_limit = NULL, monthly_email_limit = NULL WHERE id = ?`).bind(nowIso(), spaceId).run()
  }
  else {
    await env.DB.prepare(`UPDATE spaces SET storage_limit_bytes = ?, member_limit = ?, agent_limit = ?, monthly_run_limit = ?, monthly_email_limit = ?, monthly_voice_limit = ?, action_limits_json = ?, updated_at = ? WHERE id = ?`).bind(
      input.storageLimitBytes === undefined ? current.storageLimitBytes : input.storageLimitBytes,
      input.memberLimit === undefined ? current.memberLimit : input.memberLimit,
      input.agentLimit === undefined ? current.agentLimit : input.agentLimit,
      input.monthlyRunLimit === undefined ? current.monthlyRunLimit : input.monthlyRunLimit,
      input.monthlyEmailLimit === undefined ? current.monthlyEmailLimit : input.monthlyEmailLimit,
      input.monthlyVoiceLimit === undefined ? current.monthlyVoiceLimit : input.monthlyVoiceLimit,
      input.actionLimits === undefined ? current.actionLimitsJson : JSON.stringify(input.actionLimits),
      nowIso(), spaceId).run()
  }
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.limits', targetType: 'space', targetId: spaceId, meta: input })
  return toDto(await load(env, member, spaceId), member)
}

/**
 * Stops a Space being used, and starts it again. Nothing is deleted or moved. Everyone but the Owner
 * loses reach through the Space boundary, and held chat sockets are rechecked. The default Space
 * cannot be suspended: on most Servers that would be the whole Server.
 */
export async function setSpaceSuspended(env: L4Env, member: ServerMembership, spaceId: string, suspended: boolean): Promise<SpaceDTO> {
  requireOwner(member)
  const space = await load(env, member, spaceId)
  if (space.isDefault) fail(409, 'space_default', 'The default Space cannot be suspended')
  await env.DB.prepare('UPDATE spaces SET suspended_at = ?, updated_at = ? WHERE id = ?').bind(suspended ? nowIso() : null, nowIso(), spaceId).run()
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: suspended ? 'space.suspend' : 'space.resume', targetType: 'space', targetId: spaceId })
  if (suspended) {
    const channels = (await env.DB.prepare('SELECT id FROM channels WHERE space_id = ? LIMIT 500').bind(spaceId).all<{ id: string }>()).results ?? []
    await Promise.allSettled(channels.map(({ id }) => asRpc<{ revalidateAccess: () => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${id}`)).revalidateAccess()))
    await revalidateLiveRooms(env).catch(() => undefined)
  }
  return toDto(await load(env, member, spaceId), member)
}

/** Refuses while the Space holds anything of value: a deletion never takes a department's work with it. */
export async function deleteSpace(env: L4Env, member: ServerMembership, spaceId: string): Promise<void> {
  requireOwner(member)
  const space = await load(env, member, spaceId)
  if (space.isDefault) fail(409, 'space_default', 'The default Space cannot be deleted')
  const held = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM channels c WHERE c.space_id = ?1 AND (c.type <> 'text' OR EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id) OR EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = c.id)))
    + (SELECT COUNT(*) FROM projects WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM task_boards b WHERE b.space_id = ?1 AND EXISTS (SELECT 1 FROM tasks t WHERE t.board_id = b.id))
    + (SELECT COUNT(*) FROM database_definitions WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM documents WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM canvases WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM gadgets WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM mcp_outbound_connections WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM agent_environments WHERE space_id = ?1)
    + (SELECT COUNT(*) FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ?1 AND u.kind = 'agent') AS total`).bind(spaceId).first<{ total: number }>()
  if (held?.total) fail(409, 'space_not_empty', 'Remove this Space’s conversations, Projects, Data, Apps and Agents before deleting it')
  await env.DB.batch([
    env.DB.prepare('DELETE FROM channels WHERE space_id = ?').bind(spaceId),
    env.DB.prepare('DELETE FROM task_boards WHERE space_id = ?').bind(spaceId),
    env.DB.prepare('DELETE FROM channel_categories WHERE space_id = ?').bind(spaceId),
    env.DB.prepare('DELETE FROM invites WHERE space_id = ?').bind(spaceId),
    env.DB.prepare('DELETE FROM spaces WHERE id = ?').bind(spaceId),
  ])
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.delete', targetType: 'space', targetId: spaceId, meta: { name: space.name } })
  await signalMembersChanged(env, member.serverId)
  await revalidateLiveRooms(env)
}

/** The only way the Owner can read a Space's contents, and always on the record. */
export async function joinSpace(env: L4Env, member: ServerMembership, spaceId: string): Promise<SpaceDTO> {
  requireOwner(member)
  const space = await load(env, member, spaceId)
  if (space.role) return toDto(space, member)
  await env.DB.prepare("INSERT OR IGNORE INTO space_members(space_id, user_id, role, joined_at) VALUES(?, ?, 'admin', ?)").bind(spaceId, member.user.id, nowIso()).run()
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.join', targetType: 'space', targetId: spaceId, meta: { reason: 'owner' } })
  await signalMembersChanged(env, member.serverId)
  return toDto(await load(env, member, spaceId), member)
}

export async function listSpaceMembers(env: L4Env, member: ServerMembership, spaceId: string) {
  await load(env, member, spaceId)
  const rows = await env.DB.prepare(`SELECT u.id, COALESCE(u.nickname, u.display_name) AS displayName, u.kind, m.role FROM space_members m JOIN users u ON u.id = m.user_id
    WHERE m.space_id = ? AND u.status = 'active' ORDER BY displayName, u.id`).bind(spaceId).all<{ id: string; displayName: string; kind: string; role: SpaceRole }>()
  return rows.results ?? []
}

export async function addSpaceMember(env: L4Env, member: ServerMembership, spaceId: string, request: unknown) {
  await requireSpaceManager(env, member, spaceId)
  const input = spaceMemberSchema.parse(request)
  const target = await env.DB.prepare("SELECT kind, status FROM users WHERE id = ?").bind(input.userId).first<{ kind: 'human' | 'agent'; status: string }>()
  if (!target || target.status !== 'active') fail(404, 'not_found', 'Member not found')
  // An Agent belongs to the one Space it was created in, so what it knows cannot cross.
  if (target.kind === 'agent') fail(400, 'agent_one_space', 'An Agent belongs to one Space')
  const existing = await env.DB.prepare('SELECT 1 AS ok FROM space_members WHERE space_id = ? AND user_id = ?').bind(spaceId, input.userId).first()
  if (!existing) await requireMemberQuota(env, spaceId, target.kind)
  await env.DB.prepare('INSERT INTO space_members(space_id, user_id, role, joined_at) VALUES(?, ?, ?, ?) ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role')
    .bind(spaceId, input.userId, input.role, nowIso()).run()
  const self = input.userId === member.ownerId
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: self ? 'space.join' : 'space.member.add', targetType: 'space', targetId: spaceId, meta: { userId: input.userId, role: input.role } })
  await signalMembersChanged(env, member.serverId)
}

export async function updateSpaceMember(env: L4Env, member: ServerMembership, spaceId: string, userId: string, request: unknown) {
  await requireSpaceManager(env, member, spaceId)
  const input = spaceMemberPatchSchema.parse(request)
  const changed = await env.DB.prepare('UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ? RETURNING user_id').bind(input.role, spaceId, userId).first()
  if (!changed) fail(404, 'not_found', 'Member not found')
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.member.update', targetType: 'space', targetId: spaceId, meta: { userId, role: input.role } })
}

/** Leaving takes the person's private channels, Mailboxes and Grants in that Space with it. */
export async function removeSpaceMember(env: L4Env, member: ServerMembership, spaceId: string, userId: string) {
  await requireSpaceManager(env, member, spaceId)
  const target = await env.DB.prepare("SELECT u.kind FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? AND m.user_id = ?").bind(spaceId, userId).first<{ kind: string }>()
  if (!target) fail(404, 'not_found', 'Member not found')
  if (target.kind === 'agent') fail(400, 'agent_one_space', 'An Agent belongs to one Space. Delete the Agent instead')
  await env.DB.batch([
    env.DB.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').bind(spaceId, userId),
    env.DB.prepare("DELETE FROM channel_members WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE space_id = ? AND type <> 'dm')").bind(userId, spaceId),
    env.DB.prepare(`DELETE FROM grants WHERE member_id = ?1 AND (
      channel_id IN (SELECT id FROM channels WHERE space_id = ?2) OR mailbox_id IN (SELECT id FROM channels WHERE space_id = ?2)
      OR project_id IN (SELECT id FROM projects WHERE space_id = ?2) OR connection_id IN (SELECT id FROM mcp_outbound_connections WHERE space_id = ?2)
      OR agent_id IN (SELECT user_id FROM space_members WHERE space_id = ?2))`).bind(userId, spaceId),
  ])
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'space.member.remove', targetType: 'space', targetId: spaceId, meta: { userId } })
  await signalMembersChanged(env, member.serverId)
  await revalidateLiveRooms(env)
}

