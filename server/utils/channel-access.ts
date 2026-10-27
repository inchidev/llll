import { requireProject } from './project-service'
import { loadProjectPolicies } from './project-policies'
import { taskPermissionAllowed } from './task-policy'
import { parseResourceAccess } from '../../shared/resource-access'
import { getServerId } from '../../shared/server-id'
import { and, eq, inArray } from 'drizzle-orm'
import { channelRoleOverrides, channels, channelMembers, emailMailboxAccess, emailMailboxes, roles, tasks, users, server } from '../../drizzle/schema'
import { resolveChannelPermissions } from '../../shared/channel-permissions'
import { ALL_PERMISSIONS, directMessagePermissions, hasPermission, Permission, type PermissionFlag } from '../../shared/permissions'
import { mailPermissionAllows } from '../../shared/mail'
import type { ChannelType, MailboxPermission, PublicUser } from '../../shared/types'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
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
  participants: PublicUser[]
  /** The member's grant when the channel is a mailbox or one of its conversations. */
  mailPermission: MailboxPermission | null
}

export async function requireMemberForUser(env: L4Env, user: PublicUser, serverId: string, flag?: PermissionFlag, source?: Pick<AuthorizationContext, 'credential' | 'delegation'>): Promise<ServerMembership> {
  if (serverId !== (await getServerId(env.DB))) fail(404, 'not_found', 'Server not found')
  const db = getDb(env.DB)
  const [rows, homes] = await Promise.all([
    db.select({
      roleId: users.roleId,
      roleName: roles.name,
      perms: roles.permissionsBitmask,
      resourceAccessJson: roles.resourceAccessJson,
    }).from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.id, user.id), eq(users.status, 'active')))
      .limit(1),
    db.select({ ownerId: server.ownerId }).from(server).where(eq(server.id, (await getServerId(env.DB)))).limit(1),
  ])

  const row = rows[0]
  if (!row) fail(403, 'forbidden', 'Not a member of this server')
  const home = homes[0]
  if (!home) fail(404, 'not_found', 'Server not found')
  const isOwner = home.ownerId === user.id
  const perms = isOwner ? ALL_PERMISSIONS : row.perms
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
      projectPolicies: await loadProjectPolicies(env, user.id, row.roleId!),
    },
    credential: source?.credential ?? { kind: 'session' },
    ...(source?.delegation ? { delegation: source.delegation } : {}),
  }
  return {
    user,
    serverId,
    roleId: row.roleId!,
    roleName: row.roleName,
    perms,
    ownerId: home.ownerId,
    isOwner,
    authorization,
  }
}

export async function requireChannelAccessForMember(env: L4Env, member: ServerMembership | Promise<ServerMembership>, channelId: string, flag?: PermissionFlag, method = 'GET'): Promise<ServerChannelAccess> {
  const db = getDb(env.DB)
  // Membership does not depend on the channel, so both lookups share one round trip.
  // Settle both and report failures in the original order: missing channel first.
  const [channelResult, memberResult] = await Promise.allSettled([
    db.select().from(channels).where(eq(channels.id, channelId)).limit(1),
    Promise.resolve(member),
  ])
  if (channelResult.status === 'rejected') throw channelResult.reason
  const channel = channelResult.value[0]
  if (!channel) fail(404, 'not_found', 'Channel not found')

  const type = channel.type
  let accessRoot = channel
  if (type === 'thread' && channel.parentId) {
    const parent = (await db.select().from(channels).where(eq(channels.id, channel.parentId)).limit(1))[0]
    if (!parent) fail(404, 'not_found', 'Parent channel not found')
    accessRoot = parent
  }

  const rootType = accessRoot.type
  if (memberResult.status === 'rejected') throw memberResult.reason
  const baseMember = memberResult.value
  const user = baseMember.user
  if (baseMember.authorization.delegation) {
    const delegator = (await db.select().from(users).where(eq(users.id, baseMember.authorization.delegation.by)).limit(1))[0]
    if (!delegator || delegator.kind !== 'human' || delegator.status !== 'active') fail(404, 'not_found', 'Channel not found')
    // Agent identity must not expose private conversations to its token administrator.
    await requireChannelAccessForMember(env, requireMemberForUser(env, toPublicUser(delegator), baseMember.serverId), channelId, flag, method)
  }

  const [privateParts, mailboxes, grants, discussions] = await Promise.all([
    accessRoot.visibility === 'private'
      ? db.select().from(channelMembers).where(and(eq(channelMembers.channelId, accessRoot.id), eq(channelMembers.userId, baseMember.user.id))).limit(1)
      : null,
    db.select({ enabled: emailMailboxes.enabled }).from(emailMailboxes)
      .where(eq(emailMailboxes.channelId, accessRoot.id)).limit(1),
    db.select({ permission: emailMailboxAccess.permission }).from(emailMailboxAccess).where(and(
      eq(emailMailboxAccess.channelId, accessRoot.id),
      eq(emailMailboxAccess.userId, user.id),
    )).limit(1),
    db.select({ id: tasks.id, boardId: tasks.boardId, projectId: tasks.projectId }).from(tasks).where(eq(tasks.discussionChannelId, accessRoot.id)).limit(1),
  ])
  if (privateParts && !privateParts[0]) fail(404, 'not_found', 'Channel not found')
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
    const grant = grants[0]
    if (!grant) fail(404, 'not_found', 'Channel not found')
    if (flag === Permission.manageChannels) fail(403, 'forbidden', 'Manage mailboxes in email settings')
    if (flag === Permission.startLive) fail(403, 'forbidden', 'Live sessions are unavailable for mailboxes')
    const mutationWithoutFlag = !['GET', 'HEAD'].includes(method) && flag === undefined
    if ((mutationWithoutFlag || flag === Permission.sendMessages || flag === Permission.attachFiles) && !mailPermissionAllows(grant.permission, 'send')) {
      fail(403, 'forbidden', 'Mailbox is read only')
    }
  }

  if (rootType === 'dm') {
    const parts = await db.select().from(channelMembers).where(eq(channelMembers.channelId, accessRoot.id))
    const userRows = await db.select().from(users).where(inArray(users.id, parts.map((p) => p.userId)))
    const participants = userRows.map(toPublicUser)
    const canManageAgents = baseMember.isOwner || hasPermission(baseMember.perms, Permission.useAgents)
    if (user.kind !== 'agent' && participants.some(participant => participant.kind === 'agent') && !canManageAgents) {
      fail(404, 'not_found', 'Channel not found')
    }
    const stillIn = new Set(userRows.filter(row => row.status === 'active').map(row => row.id))
    const frozen = parts.some((p) => !stillIn.has(p.userId))
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
      participants,
      mailPermission: null,
      authorization: { ...baseMember.authorization, principal: { ...baseMember.authorization.principal, permissions: perms } },
    }
  }

  let perms = baseMember.perms
  if (!baseMember.isOwner) {
    const override = (await db.select({
      allow: channelRoleOverrides.allowMask,
      deny: channelRoleOverrides.denyMask,
    }).from(channelRoleOverrides).where(and(
      eq(channelRoleOverrides.channelId, accessRoot.id),
      eq(channelRoleOverrides.roleId, baseMember.roleId),
    )).limit(1))[0]
    perms = resolveChannelPermissions(perms, override)
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
    participants: [],
    mailPermission: mailbox ? grants[0]!.permission : null,
  }
}
