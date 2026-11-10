import { getServerId } from '../../../../shared/server-id'
import { taskPreview } from '../../../utils/box-preview'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

/** A short-lived link to watch the Task's box screen, for a person who may read the Task; 404 when no box runs with a viewer. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const preview = await taskPreview(env, actor.authorization, getRouterParam(event, 'id')!)
  if (!preview) fail(404, 'preview_unavailable', 'The Task’s box is not running, or its screen cannot be watched')
  return preview
})
