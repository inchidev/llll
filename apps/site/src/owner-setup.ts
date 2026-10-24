import { z } from 'zod'
import { readL4Server } from '../../../packages/deployment-core/src/servers'
import { randomCode } from '../../../shared/cloudflare-oauth'
import { normalizeServerOrigin } from '../../../shared/server-origins'
import { cloudflare } from './deploy'
import { queryRows } from './update'
import { digest, type DeploymentState } from './session'

export const ownerRecoverySchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  workerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  origin: z.string().max(2048),
})
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }) }

/** A fresh browser grant can renew an unconsumed claim, never reset an Owner. */
export async function recoverOwnerSetup(state: DeploymentState, input: z.infer<typeof ownerRecoverySchema>) {
  const grant = state.grant
  if (!grant || grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare to recover owner setup')
  const accounts = await cloudflare<{ id: string }[]>(grant.accessToken, '/accounts')
  if (!accounts.some(account => account.id === input.accountId)) fail(403, 'Choose the Cloudflare account that owns this Server')
  const server = await readL4Server(grant.accessToken, input.accountId, input.workerName)
  const origin = normalizeServerOrigin(input.origin)
  if (!server || server.origin !== origin) fail(403, 'The Worker does not match this Server address')
  if (server.configuration.authMode !== 'builtin' || !server.resources.databaseId) fail(409, 'This Server does not use password owner setup')
  const token = randomCode()
  const rows = await queryRows(grant.accessToken, input.accountId, server.resources.databaseId,
    `UPDATE server_setup SET token_hash=?,updated_at=? WHERE singleton=1
     AND NOT EXISTS(SELECT 1 FROM server) AND NOT EXISTS(SELECT 1 FROM auth_users)
     RETURNING server_name`, [await digest(token), new Date().toISOString()])
  if (!rows.length) fail(409, 'Owner setup is already complete or unavailable. Open the Server and sign in; an existing Owner cannot be reset here.')
  state.deployments = [{ accountId: input.accountId, origin, name: String(rows[0]!.server_name || 'L4'), version: server.version || '', setupToken: token }, ...(state.deployments || []).filter(item => item.origin !== origin)].slice(0, 20)
  // A completed attempt must not override the replacement handoff in /session.
  if (state.completed && state.origin === origin) state.setupToken = token
  return { claim: `${origin}/setup#claim=${token}` }
}
