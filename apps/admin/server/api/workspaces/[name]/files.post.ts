import { enableL4Files } from '@llll/admin-core'
import { adminEnv, assertMutation } from '../../../utils/http'
import { requireOwner } from '../../../utils/session'
import { requireWorkspace } from '../../../utils/workspaces'
import { cloudflareToken } from '../../../utils/credential'
import { audit } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const env = adminEnv(event)
  const workerName = getRouterParam(event, 'name') || ''
  await requireWorkspace(env, workerName)
  const result = await enableL4Files(await cloudflareToken(env), env.CLOUDFLARE_ACCOUNT_ID, workerName)
  await audit(env.ADMIN_DB, 'workspace.files.enable', workerName)
  return result
})
