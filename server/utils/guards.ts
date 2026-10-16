import { and, eq, inArray } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { channelRoleOverrides, channels, channelMembers, emailMailboxAccess, emailMailboxes, roles, tasks, users, workspace } from '../../drizzle/schema'
import { resolveChannelPermissions } from '../../shared/channel-permissions'
import { WORKSPACE_ID } from '../../shared/ids'
import { ALL_PERMISSIONS, directMessagePermissions, hasPermission, Permission, type PermissionFlag } from '../../shared/permissions'
import { mailPermissionAllows } from '../../shared/mail'
import type { ChannelType, MailboxPermission, PublicUser } from '../../shared/types'
import type { AuthorizationContext } from '../../shared/authorization'
import { requireUser } from './auth'
import { cf, fail } from './cf'
import { getDb } from './db'
import { toPublicUser } from './messages'

export type Membership = {
  user: PublicUser
  workspaceId: string
  roleId: string
  roleName: string
  perms: number
  ownerId: string
  isOwner: boolean
  authorization: AuthorizationContext
}

export type ChannelAccess = Membership & {
  channel: typeof channels.$inferSelect
  accessRootType: ChannelType
  frozen: boolean
  participants: PublicUser[]
  /** The member's grant when the channel is a mailbox or one of its conversations. */
  mailPermission: MailboxPermission | null
}

export async function requireMember(event: H3Event, workspaceId: string, flag?: PermissionFlag): Promise<Membership> {
  if (workspaceId !== WORKSPACE_ID) fail(404, 'not_found', 'Workspace not found')
  const user = await requireUser(event)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const [rows, homes] = await Promise.all([
    db.select({
      roleId: users.roleId,
      roleName: roles.name,
      perms: roles.permissionsBitmask,
    }).from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.id, user.id), eq(users.status, 'active')))
      .limit(1),
    db.select({ ownerId: workspace.ownerId }).from(workspace).where(eq(workspace.id, WORKSPACE_ID)).limit(1),
  ])

  const row = rows[0]
  if (!row) fail(403, 'forbidden', 'Not a member of this workspace')
  const home = homes[0]
  if (!home) fail(404, 'not_found', 'Workspace not found')
  const isOwner = home.ownerId === user.id
  const perms = isOwner ? ALL_PERMISSIONS : row.perms
  if (flag !== undefined && !hasPermission(perms, flag)) {
    fail(403, 'forbidden', 'Missing permission')
  }
  const authorization: AuthorizationContext = {
    workspaceId,
    principal: {
      id: user.id,
      kind: user.kind,
      roleId: row.roleId!,
      roleName: row.roleName,
      permissions: perms,
      isOwner,
    },
    credential: { kind: 'session' },
  }
  return {
    user,
    workspaceId,
    roleId: row.roleId!,
    roleName: row.roleName,
    perms,
    ownerId: home.ownerId,
    isOwner,
    authorization,
  }
}

export async function requireChannelMember(event: H3Event, channelId: string, flag?: PermissionFlag) {
  return requireChannelAccess(event, channelId, flag)
}

export async function requireChannelAccess(event: H3Event, channelId: string, flag?: PermissionFlag): Promise<ChannelAccess> {
  const user = await requireUser(event)
  const { env } = cf(event)
  const db = getDb(env.DB)
  // Membership does not depend on the channel, so both lookups share one round trip.
  // Settle both and report failures in the original order: missing channel first.
  const [channelResult, memberResult] = await Promise.allSettled([
    db.select().from(channels).where(eq(channels.id, channelId)).limit(1),
    requireMember(event, WORKSPACE_ID),
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

  const [privateParts, mailboxes, grants, discussions] = await Promise.all([
    accessRoot.visibility === 'private'
      ? db.select().from(channelMembers).where(and(eq(channelMembers.channelId, accessRoot.id), eq(channelMembers.userId, user.id))).limit(1)
      : null,
    db.select({ enabled: emailMailboxes.enabled }).from(emailMailboxes)
      .where(eq(emailMailboxes.channelId, accessRoot.id)).limit(1),
    db.select({ permission: emailMailboxAccess.permission }).from(emailMailboxAccess).where(and(
      eq(emailMailboxAccess.channelId, accessRoot.id),
      eq(emailMailboxAccess.userId, user.id),
    )).limit(1),
    db.select({ id: tasks.id }).from(tasks).where(eq(tasks.discussionChannelId, accessRoot.id)).limit(1),
  ])
  if (privateParts && !privateParts[0]) fail(404, 'not_found', 'Channel not found')
  // A task's discussion is part of the task: only people who can work with tasks may open it.
  if (discussions[0] && !baseMember.isOwner && !hasPermission(baseMember.perms, Permission.manageTasks)) {
    fail(404, 'not_found', 'Channel not found')
  }

  const mailbox = mailboxes[0]
  if (mailbox) {
    if (!mailbox.enabled) fail(404, 'not_found', 'Channel not found')
    const grant = grants[0]
    if (!grant) fail(404, 'not_found', 'Channel not found')
    if (flag === Permission.manageChannels) fail(403, 'forbidden', 'Manage mailboxes in email settings')
    if (flag === Permission.startLive) fail(403, 'forbidden', 'Live sessions are unavailable for mailboxes')
    const mutationWithoutFlag = !['GET', 'HEAD'].includes(event.method.toUpperCase()) && flag === undefined
    if ((mutationWithoutFlag || flag === Permission.sendMessages || flag === Permission.attachFiles) && !mailPermissionAllows(grant.permission, 'send')) {
      fail(403, 'forbidden', 'Mailbox is read only')
    }
  }

  if (rootType === 'dm') {
    const parts = await db.select().from(channelMembers).where(eq(channelMembers.channelId, accessRoot.id))
    const userRows = await db.select().from(users).where(inArray(users.id, parts.map((p) => p.userId)))
    const participants = userRows.map(toPublicUser)
    const canManageAgents = baseMember.isOwner || hasPermission(baseMember.perms, Permission.manageWorkspace)
    if (participants.some(participant => participant.kind === 'agent') && !canManageAgents) {
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
      workspaceId: WORKSPACE_ID,
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
