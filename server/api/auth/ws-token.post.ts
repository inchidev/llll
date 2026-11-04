import { issueWsTicket, requireUser } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const token = await issueWsTicket(event, user.id)
  return { token }
})
