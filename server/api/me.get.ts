import { currentUser } from '../utils/auth'
import { fail } from '../utils/cf'

export default defineEventHandler(async (event) => {
  const user = await currentUser(event)
  if (!user) fail(401, 'unauthorized', 'Login required')
  return { user }
})
