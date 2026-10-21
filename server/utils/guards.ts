import type { H3Event } from 'h3'
import type { PermissionFlag } from '../../shared/permissions'
import { getServerId } from '../../shared/server-id'
import { requireUser } from './auth'
import { cf, fail } from './cf'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
export type { ServerMembership as Membership, ServerChannelAccess as ChannelAccess } from './channel-access'

export async function requireMember(event: H3Event, serverId: string, flag?: PermissionFlag) {
  if (serverId !== await getServerId(cf(event).env.DB)) fail(404, 'not_found', 'Server not found')
  const user = await requireUser(event)
  return requireMemberForUser(cf(event).env, user, serverId, flag)
}

export async function requireChannelMember(event: H3Event, channelId: string, flag?: PermissionFlag) {
  return requireChannelAccess(event, channelId, flag)
}

export async function requireChannelAccess(event: H3Event, channelId: string, flag?: PermissionFlag) {
  await requireUser(event)
  const { env } = cf(event)
  return requireChannelAccessForMember(env, requireMember(event, await getServerId(env.DB)), channelId, flag, event.method.toUpperCase())
}
