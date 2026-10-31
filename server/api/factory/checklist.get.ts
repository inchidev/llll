import { cf } from '../../utils/cf'
import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { requireMember } from '../../utils/guards'
import { factoryChecklist } from '../../utils/factory-checklist'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  await requireMember(event, await getServerId(env.DB), Permission.manageServer)
  return factoryChecklist(env)
})
