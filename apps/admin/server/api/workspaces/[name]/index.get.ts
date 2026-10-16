import { readDomains } from '../../../utils/domains'
import { adminEnv, errorMessage } from '../../../utils/http'
import { liveStatus } from '../../../utils/live'
import { requireOwner } from '../../../utils/session'
import { ownerSetupState, workspaceSummary } from '../../../utils/workspaces'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  setHeader(event, 'Cache-Control', 'no-store')
  const env = adminEnv(event)
  const workerName = getRouterParam(event, 'name') || ''
  const workspace = await workspaceSummary(env, workerName)
  const [ownerSetupRequired, domains, live] = await Promise.all([
    ownerSetupState(workspace.origin),
    workspace.linked ? readDomains(env, workerName).catch(error => ({ error: errorMessage(error) })) : null,
    liveStatus(env, workerName),
  ])
  return { workspace, ownerSetupRequired, domains, live }
})
