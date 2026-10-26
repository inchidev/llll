import { cf, fail } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { findAgentRun } from '../../../utils/agent-run-service'
import { factoryAuthority, factoryWorkspace } from '../../../utils/factory-authority'

/** Explicit human export. A short-lived read token is never an Agent tool result. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  const context = await factoryAuthority(env, run.id, actor.user.id, false, true)
  if (!('provider' in context.capabilities) || !env.FACTORY_CODE) fail(409, 'factory_export_local', 'Use llll factory backup on the trusted VPS host to export local source and receipts')
  const workspace = await factoryWorkspace(env, context)
  const name = `l4-${context.auth.serverId.replaceAll('-', '')}-${workspace.id.replaceAll('-', '')}`
  using repository = await env.FACTORY_CODE.get(name)
  const info = await repository.info(), token = await repository.createToken('read', 300)
  return { remote: info.remote, token: token.plaintext, expiresAt: token.expiresAt, instruction: 'Private read access for this Task repository only. Clone with an Authorization Bearer Git extraHeader. The l4-state branch contains private working/index checkpoints; its first parent is the exact upstream-publication HEAD. Keep this token private.' }
})
