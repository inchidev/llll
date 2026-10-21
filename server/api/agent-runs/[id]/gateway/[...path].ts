import { toWebRequest } from 'h3'
import { agentGateway } from '../../../../utils/agent-gateway'
import { cf } from '../../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env, waitUntil } = cf(event)
  return agentGateway(toWebRequest(event), env, getRouterParam(event, 'id')!, getRouterParam(event, 'path')!, waitUntil)
})
