import { requireProject } from './project-service'
import { taskPermissionAllowed } from './task-policy'
import { parseResourceAccess } from '../../shared/resource-access'
import { getServerId } from '../../shared/server-id'
import { eq, getTableColumns, inArray } from 'drizzle-orm'
import { channels, channelMembers, spaceMembers, users } from '../../drizzle/schema'
import { CHANNEL_ROLE_OVERRIDE_SQL, resolveChannelPermissions } from '../../shared/channel-permissions'
import { ALL_PERMISSIONS, directMessagePermissions, hasPermission, Permission, type PermissionFlag } from '../../shared/permissions'
import { mailboxGrantPermissionSql, mailPermissionAllows } from '../../shared/mail'
import type { ChannelType, MailboxPermission, PublicUser } from '../../shared/types'
import { dmFrozen } from '../../shared/dm'
import { ARCHIVED_CHANNEL_WITHHELD, CHANNEL_ARCHIVED_CODE, CHANNEL_ARCHIVED_MESSAGE } from '../../shared/channel-archive'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { SpaceAdminPermissions, spaceAllowed } from '../../shared/spaces'
import { fail } from './cf'
import { loadMemberRows, loadSpaceBoundary, type SpaceRequest } from './space-access'
import { getDb } from './db'
import { toPublicUser } from './messages'

export type ServerMembership = {
  user: PublicUser
  serverId: string
  roleId: string
  roleName: string
  perms: number
  ownerId: string
  isOwner: boolean
  authorization: AuthorizationContext
}

export type ServerChannelAccess = ServerMembership & {
  channel: typeof channels.$inferSelect
  accessRootType: ChannelType
  frozen: boolean
  /** When the channel, or a Thread's parent channel, was archived. */
  archivedAt: string | null
  participants: PublicUser[]
  /** The member's grant when the channel is a mailbox or one of its conversations. */
  mailPermission: MailboxPermission | null
}

/** Writes that are not covered by a withheld channel grant (reactions, pins, settings) call this. */
export function requireActiveChannel(access: Pick<ServerChannelAccess, 'archivedAt'>) {
  if (access.archivedAt) fail(409, CHANNEL_ARCHIVED_CODE, CHANNEL_ARCHIVED_MESSAGE)
}

export async function requireMemberForUser(env: L4Env, user: PublicUser, serverId: string, flag?: PermissionFlag, source?: Partial<Pick<AuthorizationContext, 'credential' | 'delegation' | 'spaces'>> & SpaceRequest): Promise<ServerMembership> {
  if (serverId !== (await getServerId(env.DB))) fail(404, 'not_found', 'Server not found')
  const delegatedBy = source?.delegation?.by ?? null
  // The route check read this Member's rows already. A delegated request also needs its delegator's Spaces.
  const { member: row, spaces, policies } = source?.memberRows?.userId === user.id && !delegatedBy
    ? source.memberRows
    : (await loadMemberRows(env, user.id, { delegatedBy })).rows
  if (!row) fail(403, 'forbidden', 'Not a member of this server')
  if (!row.ownerId) fail(404, 'not_found', 'Server not found')
  const ownerId = row.ownerId
  const isOwner = ownerId === user.id
  const boundary = source?.spaces ? { ...source.spaces, adminHere: false } : await loadSpaceBoundary(env, user.id, { delegatedBy, scope: source?.spaceScope, rows: spaces })
  // A Space admin's extra permissions exist only on a request the route policy scoped to their Space.
  const perms = isOwner ? ALL_PERMISSIONS : row.perms | (source?.spaceAdmin && boundary.adminHere ? SpaceAdminPermissions : 0)
  if (flag !== undefined && !hasPermission(perms, flag)) {
    fail(403, 'forbidden', 'Missing permission')
  }
  const authorization: AuthorizationContext = {
    serverId,
    principal: {
      id: user.id,
      kind: user.kind,
      roleId: row.roleId!,
      roleName: row.roleName,
      permissions: perms,
      isOwner,
      resourceAccess: parseResourceAccess(row.resourceAccessJson),
      projectPolicies: policies,
    },
    spaces: { ids: boundary.ids, active: boundary.active, denied: boundary.denied },
    credential: source?.credential ?? { kind: 'session' },
    ...(source?.delegation ? { delegation: source.delegation } : {}),
  }
  return {
    user,
    serverId,
    roleId: row.roleId!,
    roleName: row.roleName,
    perms,
    ownerId,
    isOwner,
    authorization,
  }
}

const CHANNEL_SELECT = Object.entries(getTableColumns(channels)).map(([key, column]) => `${column.name} AS ${key}`).join(',')

/** What decides a Member's access to one channel, in this order. The Owner has no Role override to read. */
function accessFactStatements(env: L4Env, rootId: string, member: ServerMembership) {
  return [
    env.DB.prepare('SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND user_id = ? LIMIT 1').bind(rootId, member.user.id),
    env.DB.prepare('SELECT enabled FROM email_mailboxes WHERE channel_id = ? LIMIT 1').bind(rootId),
    env.DB.prepare(`SELECT ${mailboxGrantPermissionSql('g')} AS permission FROM grants g WHERE g.mailbox_id = ? AND g.member_id = ?`).bind(rootId, member.user.id),
    env.DB.prepare('SELECT id, board_id AS boardId, project_id AS projectId FROM tasks WHERE discussion_channel_id = ? LIMIT 1').bind(rootId),
    ...member.isOwner ? [] : [env.DB.prepare(CHANNEL_ROLE_OVERRIDE_SQL).bind(rootId, member.roleId)],
  ]
}

export async function requireChannelAccessForMember(env: L4Env, member: ServerMembership | Promise<ServerMembership>, channelId: string, flag?: PermissionFlag, method = 'GET'): Promise<ServerChannelAccess> {
  const db = getDb(env.DB)
  // A Member already known shares one round trip with the channel. One still loading runs alongside it.
  const known = member instanceof Promise ? null : member
  // Settle both and report failures in the original order: missing channel first.
  const [channelResult, memberResult] = await Promise.allSettled([
    env.DB.batch<unknown>([
      env.DB.prepare(`SELECT ${CHANNEL_SELECT} FROM channels WHERE id = ?1 OR id = (SELECT parent_id FROM channels WHERE id = ?1 AND type = 'thread')`).bind(channelId),
      ...known ? accessFactStatements(env, channelId, known) : [],
    ]),
    Promise.resolve(member),
  ])
  if (channelResult.status === 'rejected') throw channelResult.reason
  const [found, ...firstFacts] = channelResult.value
  const candidates = (found?.results ?? []) as Array<typeof channels.$inferSelect>
  const channel = candidates.find(row => row.id === channelId)
  if (!channel) fail(404, 'not_found', 'Channel not found')

  const type = channel.type
  let accessRoot = channel
  if (type === 'thread' && channel.parentId) {
    const parent = candidates.find(row => row.id === channel.parentId)
    if (!parent) fail(404, 'not_found', 'Parent channel not found')
    accessRoot = parent
  }

  const rootType = accessRoot.type
  if (memberResult.status === 'rejected') throw memberResult.reason
  const baseMember = memberResult.value
  const user = baseMember.user
  // The Space comes first: a channel in another Space does not exist for this Member, Owner included.
  if (!spaceAllowed(baseMember.authorization, accessRoot.spaceId)) fail(404, 'not_found', 'Channel not found')
  if (baseMember.authorization.delegation) {
    const delegator = (await db.select().from(users).where(eq(users.id, baseMember.authorization.delegation.by)).limit(1))[0]
    if (!delegator || delegator.kind !== 'human' || delegator.status !== 'active') fail(404, 'not_found', 'Channel not found')
    // Agent identity must not expose private conversations to its token administrator.
    await requireChannelAccessForMember(env, requireMemberForUser(env, toPublicUser(delegator), baseMember.serverId), channelId, flag, method)
  }

  // A Thread is authorized by its parent, so it needs the parent's facts.
  const facts = known && accessRoot.id === channelId ? firstFacts : await env.DB.batch<unknown>(accessFactStatements(env, accessRoot.id, baseMember))
  const [privateParts, mailboxes, grants, discussions, overrides] = facts.map(fact => fact.results ?? []) as [
    unknown[], Array<{ enabled: number }>, Array<{ permission: MailboxPermission }>, Array<{ id: string; boardId: string; projectId: string | null }>, Array<{ allow: number | null; deny: number | null }> | undefined,
  ]
  if (accessRoot.visibility === 'private' && !privateParts[0]) fail(404, 'not_found', 'Channel not found')
  // A task's discussion is part of the task: only people who can work with tasks may open it.
  if (discussions[0] && !taskPermissionAllowed(baseMember.authorization, discussions[0], Permission.readTasks)) {
    fail(404, 'not_found', 'Channel not found')
  }

  if (discussions[0]) {
    if (discussions[0].projectId) await requireProject(env, baseMember.authorization, discussions[0].projectId)
  }

  const mailbox = mailboxes[0]
  if (mailbox) {
    if (!mailbox.enabled) fail(404, 'not_found', 'Channel not found')
    if (!baseMember.isOwner && !hasPermission(baseMember.perms, Permission.readMail)) fail(404, 'not_found', 'Channel not found')
    const grant = grants[0]
    if (!grant) fail(404, 'not_found', 'Channel not found')
    if (flag === Permission.manageChannels) fail(403, 'forbidden', 'Manage mailboxes in email settings')
    if (flag === Permission.startLive) fail(403, 'forbidden', 'Live sessions are unavailable for mailboxes')
    const mutationWithoutFlag = !['GET', 'HEAD'].includes(method) && flag === undefined
    if ((mutationWithoutFlag || flag === Permission.sendMessages || flag === Permission.attachFiles) && (!mailPermissionAllows(grant.permission, 'send') || (!baseMember.isOwner && !hasPermission(baseMember.perms, Permission.sendMail)))) {
      fail(403, 'forbidden', 'Mailbox is read only')
    }
  }

  if (rootType === 'dm') {
    const [parts, userRows, inSpace] = await db.batch([
      db.select().from(channelMembers).where(eq(channelMembers.channelId, accessRoot.id)),
      db.select().from(users).where(inArray(users.id, db.select({ id: channelMembers.userId }).from(channelMembers).where(eq(channelMembers.channelId, accessRoot.id)))),
      db.select({ userId: spaceMembers.userId }).from(spaceMembers).where(eq(spaceMembers.spaceId, accessRoot.spaceId)),
    ])
    const participants = userRows.map(toPublicUser)
    const canManageAgents = baseMember.isOwner || hasPermission(baseMember.perms, Permission.useAgents)
    if (user.kind !== 'agent' && participants.some(participant => participant.kind === 'agent') && !canManageAgents) {
      fail(404, 'not_found', 'Channel not found')
    }
    const spaceIds = new Set(inSpace.map(row => row.userId))
    const stillIn = new Set(userRows.filter(row => row.status === 'active' && spaceIds.has(row.id)).map(row => row.id))
    const frozen = dmFrozen(parts.length, parts.filter(p => stillIn.has(p.userId)).length)
    const perms = directMessagePermissions(baseMember.perms, baseMember.isOwner, frozen)
    if (flag === Permission.startLive && frozen) fail(403, 'forbidden', 'This direct message can no longer start calls')
    if (flag !== undefined && !frozen && !hasPermission(perms, flag) && flag !== Permission.sendMessages) {
      fail(403, 'forbidden', 'Missing permission')
    }
    if (flag === Permission.sendMessages && frozen) fail(403, 'forbidden', 'You can no longer send messages to this user')
    return {
      user,
      serverId: (await getServerId(env.DB)),
      roleId: '',
      roleName: 'member',
      perms,
      ownerId: baseMember.ownerId,
      isOwner: baseMember.isOwner,
      channel,
      accessRootType: rootType,
      frozen,
      archivedAt: null,
      participants,
      mailPermission: null,
      authorization: { ...baseMember.authorization, principal: { ...baseMember.authorization.principal, permissions: perms } },
    }
  }

  let perms = baseMember.perms
  if (!baseMember.isOwner) perms = resolveChannelPermissions(perms, overrides?.[0] ?? null)
  if (mailbox && mailPermissionAllows(grants[0]!.permission, 'send') && (baseMember.isOwner || hasPermission(baseMember.perms, Permission.sendMail))) {
    perms |= Permission.sendMessages | Permission.attachFiles
  }
  // Archiving is checked before the role so every send, upload and Live start answers the same way.
  const archivedAt = accessRoot.type === 'text' ? accessRoot.archivedAt ?? null : null
  if (archivedAt) {
    if (flag !== undefined && (flag & ARCHIVED_CHANNEL_WITHHELD)) fail(409, CHANNEL_ARCHIVED_CODE, CHANNEL_ARCHIVED_MESSAGE)
    perms &= ~ARCHIVED_CHANNEL_WITHHELD
  }
  if (flag !== undefined && !hasPermission(perms, flag)) {
    fail(403, 'forbidden', 'Missing permission')
  }

  return {
    ...baseMember,
    perms,
    authorization: { ...baseMember.authorization, principal: { ...baseMember.authorization.principal, permissions: perms } },
    channel,
    accessRootType: rootType,
    frozen: false,
    archivedAt,
    participants: [],
    mailPermission: mailbox ? grants[0]!.permission : null,
  }
}
