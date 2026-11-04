import { toWebRequest } from 'h3'
import { acceptSignedInboundEmail } from '../../../../workers/inbound-email'
import { cf } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  return acceptSignedInboundEmail(toWebRequest(event), env)
})
