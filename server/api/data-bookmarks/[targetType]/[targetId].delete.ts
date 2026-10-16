import { WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

const targetTypes = new Set(['database_view', 'document', 'canvas'])

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const targetType = getRouterParam(event, 'targetType')!
  const targetId = getRouterParam(event, 'targetId')!
  if (!targetTypes.has(targetType)) fail(400, 'bad_request', 'Unsupported bookmark target')
  await cf(event).env.DB.prepare('DELETE FROM data_bookmarks WHERE user_id = ? AND target_type = ? AND target_id = ?')
    .bind(actor.user.id, targetType, targetId).run()
  return { ok: true }
})
