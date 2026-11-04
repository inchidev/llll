import { requireUser } from '../../utils/auth'
import { authFromEvent } from '../../utils/better-auth'

export default defineEventHandler(async (event): Promise<{ providers: string[] }> => {
  await requireUser(event)
  const auth = await authFromEvent(event)
  const accounts = await auth.api.listUserAccounts({ headers: event.headers })
  return { providers: [...new Set(accounts.map(account => account.providerId))] }
})
