import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '../../../drizzle/schema'
import { sessionUser } from '../../utils/auth'
import { authFromEvent } from '../../utils/better-auth'
import { provisionWorkspace } from '../../utils/bootstrap'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated, getDb, workspaceReady } from '../../utils/db'
import { ensureWorkspaceMailFromEnv } from '../../utils/workspace-mail'
import { ownerSetupTokenMatches, readOwnerSetupEnv } from '../../utils/owner-setup'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  token: z.string().min(32).max(256),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(200),
})

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  if (await workspaceReady(env.DB)) fail(409, 'workspace_ready', 'Workspace setup is already complete')

  const setup = readOwnerSetupEnv(env)
  if (!setup) fail(503, 'setup_unavailable', 'Owner setup is not configured')

  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || 'local'
  let allowed = true
  try {
    const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`ip:${ip}:owner-setup`))
    allowed = await limiter.take(5, 60 * 60 * 1000)
  }
  catch {
    // nuxt cloudflare-dev does not export DOs
  }
  if (!allowed) fail(429, 'rate_limited', 'Too many setup attempts')
  if (!ownerSetupTokenMatches(setup.token, body.token)) fail(403, 'invalid_setup', 'This setup link is invalid or expired')

  const handle = (setup.email.split('@')[0] || 'owner').slice(0, 32)
  let provisioned
  try {
    provisioned = await provisionWorkspace(event, {
      email: setup.email,
      password: body.password,
      handle,
      displayName: body.name,
      workspaceName: setup.workspaceName,
    })
  }
  catch (error) {
    if (await workspaceReady(env.DB)) fail(409, 'workspace_ready', 'Workspace setup is already complete')
    throw error
  }
  await ensureWorkspaceMailFromEnv(env)

  const auth = await authFromEvent(event)
  const response = await auth.api.signInEmail({
    headers: event.headers,
    body: { email: setup.email, password: body.password },
    asResponse: true,
  })
  if (!response.ok) fail(500, 'setup_login_failed', 'Owner was created. Sign in to continue.')
  for (const cookie of response.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)
  const row = (await getDb(env.DB).select().from(users).where(eq(users.id, provisioned.userId)).limit(1))[0]!
  return { user: await sessionUser(event, row, setup.email) }
})
