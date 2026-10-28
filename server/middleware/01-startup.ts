import { ensureServerStarted } from '../utils/server-startup'

export default defineEventHandler(async (event) => {
  if ((event.path || '').startsWith('/ws/')) return
  await ensureServerStarted(event)
})
