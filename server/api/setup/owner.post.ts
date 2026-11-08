import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '../../../drizzle/schema'
import { normalizeUsername, optionalEmailSchema, usernameSchema } from '../../../shared/account'
import { addPendingEmail } from '../../utils/account-email'
import { sessionUser } from '../../utils/auth'
import { authFromEvent } from '../../utils/better-auth'
import { provisionServer } from '../../utils/bootstrap'
import { cf, fail } from '../../utils/cf'
import { applyCloudSeed, readCloudSeed } from '../../utils/cloud-seed'
import { ensureMigrated, getDb, serverReady } from '../../utils/db'
import { newId } from '../../../shared/ids'
import { ensureServerMailFromEnv } from '../../utils/server-mail'
import { readOwnerSetup, verifyOwnerSetupToken } from '../../utils/owner-setup'
import { parseBody } from '../../utils/validate'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'

const bodySchema = z.object({
  token: z.string().min(32).max(256),
  username: usernameSchema,
  name: z.string().trim().max(80).optional(),
  email: optionalEmailSchema,
  serverName: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(12).max(200),
})

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  if (await serverReady(env.DB)) fail(409, 'server_ready', 'Server setup is already complete')

  const setup = await readOwnerSetup(env.DB, env)
  if (!setup) fail(503, 'setup_unavailable', 'Owner setup is not configured')

  await requireRateLimit(event, [{ key: `ip:${clientIp(event)}:owner-setup`, limit: 5, windowMs: 60 * 60 * 1000 }], 'Too many setup attempts')
  if (!await verifyOwnerSetupToken(setup, body.token)) fail(403, 'invalid_setup', 'This setup link is invalid or expired')

  // What L4 Cloud left for this claim (ADR 0012): it goes with the setup row, so it is read first.
  const seed = await readCloudSeed(env.DB)
  const userId = newId()
  let provisioned
  try {
    provisioned = await provisionServer(event, {
      userId,
      username: body.username,
      password: body.password,
      handle: normalizeUsername(body.username),
      displayName: body.name || body.username,
      serverName: body.serverName || setup.serverName,
    })
  }
  catch (error) {
    if (await serverReady(env.DB)) fail(409, 'server_ready', 'Server setup is already complete')
    throw error
  }
  await ensureServerMailFromEnv(env)
  // The seed's Agent, identity, secrets and env, created by the new Owner as the Owner would.
  if (seed) await applyCloudSeed(env, { serverId: provisioned.serverId, ownerId: provisioned.userId, seed })
  await env.DB.prepare('DELETE FROM server_setup WHERE singleton = 1').run()

  const auth = await authFromEvent(event)
  const response = await auth.api.signInUsername({
    headers: event.headers,
    body: { username: body.username, password: body.password },
    asResponse: true,
  })
  if (!response.ok) fail(500, 'setup_login_failed', 'Owner was created. Sign in to continue.')
  for (const cookie of response.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)
  if (body.email) await addPendingEmail(event, provisioned.userId, body.email)
  const row = (await getDb(env.DB).select().from(users).where(eq(users.id, provisioned.userId)).limit(1))[0]!
  return { user: await sessionUser(event, row, { username: normalizeUsername(body.username), displayUsername: body.username, email: null }) }
})
