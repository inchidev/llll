import { readMeta, writeMeta } from '../utils/db'
import { adminEnv } from '../utils/http'

let known: string | null = null

/** Remember the Admin's public origin; workspaces and the directory link to it. */
export default defineEventHandler(async (event) => {
  const origin = getRequestURL(event).origin
  if (!origin.startsWith('https://') || origin === known) return
  const env = adminEnv(event)
  if ((await readMeta(env.ADMIN_DB, 'origin')) !== origin) await writeMeta(env.ADMIN_DB, 'origin', origin)
  known = origin
})
