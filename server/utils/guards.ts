import { authorizeResourceRequest } from './resource-policy'
import type { H3Event } from 'h3'
import type { PermissionFlag } from '../../shared/permissions'
import { getServerId } from '../../shared/server-id'
import { requireUser } from './auth'
import { cf, fail } from './cf'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import { requestSpace } from './route-gate'
export type { ServerMembership as Membership, ServerChannelAccess as ChannelAccess } from './channel-access'

export async function requireMember(event: H3Event, serverId: string, flag?: PermissionFlag) {
  if (serverId !== await getServerId(cf(event).env.DB)) fail(404, 'not_found', 'Server not found')
  const user = await requireUser(event)
  const member = await requireMemberForUser(cf(event).env, user, serverId, flag, requestSpace(event))
  const path = event.path.split('?')[0]!
  if (!/^\/api\/boards\/[^/]+\/tasks(?:\/reorder)?$/u.test(path) && (event.method !== 'GET' || !path.match(/^\/api\/servers\/[^/]+\/(boards|documents|databases|canvases)$/u))) {
    await authorizeResourceRequest(cf(event).env, member.authorization, path)
  }
  return member
}

export async function requireChannelMember(event: H3Event, channelId: string, flag?: PermissionFlag) {
  return requireChannelAccess(event, channelId, flag)
}

export async function requireChannelAccess(event: H3Event, channelId: string, flag?: PermissionFlag) {
  await requireUser(event)
  const { env } = cf(event)
  // Usually the route check already read the Member, and then the channel's facts come with the channel.
  const member = requireMember(event, await getServerId(env.DB))
  const [settled] = await Promise.allSettled([member])
  // A refused Member still answers after the channel: a channel that does not exist is reported first.
  return requireChannelAccessForMember(env, settled.status === 'fulfilled' ? settled.value : member, channelId, flag, event.method.toUpperCase())
}
