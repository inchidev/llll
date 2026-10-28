import { getServerId } from '../../../../../shared/server-id'
import { z } from 'zod'
import { realtimekitSettings } from '../../../../../drizzle/schema'
import type { RealtimeKitSettingsAdminDTO } from '../../../../../shared/types'
import { nowIso } from '../../../../../shared/ids'
import { encryptSecret } from '../../../../../shared/encrypted-secret'
import {
  connectRealtimeKit,
  loadRealtimeKitConfig,
  RealtimeKitHttpError,
  REALTIMEKIT_SECRET_SCOPE,
  realtimekitConfigured,
  realtimekitSettingsAdminDto,
  testRealtimeKitConnection,
  type RealtimeKitAccount,
} from '../../../../../workers/realtimekit'
import { callsProvider } from '../../../../../workers/env'
import { authSecret } from '../../../../utils/auth-config'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { requireMember } from '../../../../utils/guards'
import { closeLiveRooms } from '../../../../utils/live'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({
  /** Omitted to reconnect with the saved token, for example to provision split presets. */
  apiToken: z.string().trim().min(1).max(4000).optional(),
  accountId: z.string().trim().regex(/^[a-f0-9]{32}$/iu).optional(),
})

/**
 * Connect Live with one Cloudflare API token. L4 finds the account,
 * reuses or creates this server's RealtimeKit app, provisions the host and
 * participant presets, verifies them, and stores the token encrypted.
 */
export default defineEventHandler(async (event): Promise<{ realtimekit: RealtimeKitSettingsAdminDTO } | { accounts: RealtimeKitAccount[] }> => {
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can connect RealtimeKit')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  if (!callsProvider(env)) fail(501, 'calls_unavailable', 'Calls use Cloudflare RealtimeKit and are unavailable on this runtime')
  const current = await loadRealtimeKitConfig(env)
  if (current.source === 'deployment') fail(400, 'managed_by_deployment', 'RealtimeKit is managed by the deployment')

  // Live reads the saved token with AUTH_SECRET alone, so never encrypt it with
  // the localhost development fallback that nothing could decrypt later.
  if (!env.AUTH_SECRET?.trim()) {
    fail(409, 'auth_secret_required', 'Set AUTH_SECRET for this Server before connecting RealtimeKit; the token is encrypted with it. Locally, run pnpm env:init or pnpm dev:stack.')
  }

  const apiToken = body.apiToken || (current.secretReadable ? current.apiToken : '')
  if (!apiToken) fail(400, 'api_token_required', 'Paste a Cloudflare API token to connect')

  const origin = getRequestURL(event)
  let connection: Awaited<ReturnType<typeof connectRealtimeKit>>
  try {
    connection = await connectRealtimeKit(apiToken, {
      accountId: body.accountId ?? (body.apiToken ? undefined : current.accountId || undefined),
      appName: `L4 ${origin.host}`,
    })
    if ('accounts' in connection) return connection
    await testRealtimeKitConnection({ ...current, ...connection, apiToken, source: 'database' })
  }
  catch (error) {
    if (error instanceof RealtimeKitHttpError && (error.status === 401 || error.status === 403)) {
      fail(400, 'invalid_credentials', 'Cloudflare rejected the token. Give it Realtime Admin access to the account.')
    }
    fail(502, 'realtimekit_connection_failed', error instanceof Error ? error.message : 'RealtimeKit connection failed')
  }

  const encrypted = await encryptSecret(authSecret(env), REALTIMEKIT_SECRET_SCOPE, apiToken)
  // Rooms started in another app, or through the REST fallback, could not be
  // ended once this connection takes over, so end them while they still can be.
  const sameApp = realtimekitConfigured(current)
    && current.accountId === connection.accountId
    && current.appId === connection.appId
  if (!sameApp) await closeLiveRooms(env)
  const db = getDb(env.DB)
  const timestamp = nowIso()
  const values = {
    accountId: connection.accountId,
    appId: connection.appId,
    apiTokenCiphertext: encrypted.ciphertext,
    apiTokenIv: encrypted.iv,
    apiTokenVersion: encrypted.version,
    hostPreset: connection.hostPreset,
    participantPreset: connection.participantPreset,
    updatedAt: timestamp,
  }
  await db.insert(realtimekitSettings)
    .values({ id: 1, ...values, createdAt: timestamp })
    .onConflictDoUpdate({ target: realtimekitSettings.id, set: values })

  await writeAudit(env, {
    serverId: (await getServerId(cf(event).env.DB)),
    actorId: member.user.id,
    action: 'realtimekit.settings.connect',
    targetType: 'server',
    targetId: (await getServerId(cf(event).env.DB)),
    meta: { appId: connection.appId, token: body.apiToken ? 'replaced' : 'unchanged' },
  })
  return { realtimekit: realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)) }
})
