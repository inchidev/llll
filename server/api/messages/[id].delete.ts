import { retryDeletedFiles } from '../../../shared/file-cleanup'
import { getServerId } from '../../../shared/server-id'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { deleteChannelMessage } from '../../utils/message-service'

export default defineEventHandler(async (event) => {
  const { env, waitUntil } = cf(event)
  const result = await deleteChannelMessage(env, await requireMember(event, await getServerId(env.DB)), getRouterParam(event, 'id')!)
  waitUntil(retryDeletedFiles(env))
  return result
})
