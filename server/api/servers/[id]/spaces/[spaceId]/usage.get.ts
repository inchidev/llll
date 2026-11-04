import { cf, fail } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { spaceUsage } from '../../../../../utils/space-quota'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const { env } = cf(event), spaceId = getRouterParam(event, 'spaceId')!
  const row = await env.DB.prepare('SELECT role FROM space_members WHERE space_id = ? AND user_id = ?').bind(spaceId, member.user.id).first<{ role: string }>()
  if (!member.isOwner && row?.role !== 'admin') fail(404, 'not_found', 'Space not found')
  return { usage: await spaceUsage(env, spaceId) }
})
