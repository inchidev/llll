import { Permission } from '../../../../../../../shared/permissions'
import { requireMember } from '../../../../../../utils/guards'
import { cf } from '../../../../../../utils/cf'

export default defineEventHandler(async (event) => {
  await requireMember(event, getRouterParam(event, 'id')!, Permission.manageRoles)
  const { env } = cf(event)
  const rows = await env.DB.prepare('SELECT policy_id AS id FROM role_policies WHERE role_id=? ORDER BY policy_id')
    .bind(getRouterParam(event, 'roleId')!).all<{ id: string }>()
  return { policyIds: rows.results.map(row => row.id) }
})
