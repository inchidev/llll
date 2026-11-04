import { toWebRequest } from 'h3'
import { acceptPostmarkInbound } from '../../../../workers/inbound-email'
import { cf } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  return acceptPostmarkInbound(toWebRequest(event), env)
})
