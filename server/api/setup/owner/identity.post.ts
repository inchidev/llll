import { z } from 'zod'
import { cf, fail } from '../../../utils/cf'
import { ensureMigrated, serverReady } from '../../../utils/db'
import { readOwnerSetup, verifyOwnerSetupToken } from '../../../utils/owner-setup'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  token: z.string().min(32).max(256),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  if (await serverReady(env.DB)) fail(409, 'server_ready', 'Server setup is already complete')

  const setup = await readOwnerSetup(env.DB, env)
  const email = await verifyOwnerSetupToken(setup, body.token)
  if (!email) fail(403, 'invalid_setup', 'This setup link is invalid or expired')
  return { email, serverName: setup?.serverName }
})
