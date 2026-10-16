import { toWebRequest } from 'h3'
import { acceptSesInbound } from '../../../../workers/inbound-email'
import { cf } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  return acceptSesInbound(toWebRequest(event), env)
})
