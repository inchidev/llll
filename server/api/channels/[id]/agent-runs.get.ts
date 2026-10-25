import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { requireChannelMember, requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'

/** Queue controls must not wait for provider catalog discovery. */
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.useAgents)
  await requireChannelMember(event, id)
  setHeader(event, 'Cache-Control', 'no-store')
  const active = await env.DB.prepare("SELECT id,channel_id as channelId,initiated_by as initiatedBy,prompt,agent_id as agentId,status FROM agent_runs WHERE (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status IN ('queued','running') ORDER BY created_at LIMIT 100")
    .bind(id, id).all<{ id: string; channelId: string; initiatedBy: string; prompt: string; agentId: string; status: string }>()
  return { active: (active.results ?? []).map(run => ({ ...run, prompt: run.initiatedBy === actor.user.id ? run.prompt : 'Private Run' })) }
})
