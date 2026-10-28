import type { H3Event } from 'h3'
import { agentProviderCatalog } from '../../utils/agent-providers'
import { piConfigured } from '../../utils/agent-run-service'
import { liveAvailable } from '../../../workers/realtimekit'
import { readAdminEnv } from '../../utils/bootstrap'
import { cf } from '../../utils/cf'
import { currentUser } from '../../utils/auth'
import { schemaCurrent, userCount, serverReady } from '../../utils/db'
import type { SetupBindings, SetupHealth, SetupHealthDetails } from '../../../shared/types'
import { readAppBranding } from '../../../shared/app-branding'
import { maskedOwnerEmail, readOwnerSetup } from '../../utils/owner-setup'
import { serverVersion } from '../../utils/version'
import { publicServerAppearance } from '../../utils/server-appearance'
import { requestServerOrigin } from '../../utils/server-origins'
import { authMode } from '../../utils/cloudflare-access'
import { agentBrowserConfigured, aiProvider, type L4Env } from '../../../workers/env'
import { serverAiModel, serverCapabilities } from '../../../workers/server-capabilities'

function readBindings(env: L4Env): SetupBindings {
  return {
    db: Boolean(env.DB),
    r2: Boolean(env.FILES),
    kv: Boolean(env.TICKETS),
    channelDo: Boolean(env.CHANNEL_DO),
    serverDo: Boolean(env.SERVER_DO),
    rateLimitDo: Boolean(env.RATE_LIMIT_DO),
    notificationDo: Boolean(env.NOTIFICATION_DO),
    agentDo: Boolean(env.AGENT_DO),
    workersAi: Boolean(env.AI),
    browser: agentBrowserConfigured(env),
  }
}

async function signedIn(event: H3Event): Promise<boolean> {
  try { return Boolean(await currentUser(event)) }
  catch { return false }
}

async function runtimeDetails(env: L4Env, migrated: boolean, users: number): Promise<SetupHealthDetails> {
  return {
    users,
    bindings: readBindings(env),
    aiProvider: aiProvider(env),
    aiModel: (migrated ? (await agentProviderCatalog(env)).defaultModel : null) ?? serverAiModel(env),
    capabilities: { ...serverCapabilities(env), containers: migrated ? await piConfigured(env) : false },
    realtimekit: await liveAvailable(env),
    twitterAuth: Boolean(env.TWITTER_CLIENT_ID?.trim() && env.TWITTER_CLIENT_SECRET?.trim()),
  }
}

/**
 * Read-only. Schema bootstrap, the env owner and the primary origin are
 * initialised once per isolate by server/middleware/01-startup.ts.
 *
 * Unauthenticated callers (the installer's deploy verification, the sign-in
 * and setup pages, container health checks) get only what they need; runtime
 * details (bindings, AI provider/model, capabilities, member count) are for
 * signed-in members. The response is same-origin only: no CORS.
 */
export default defineEventHandler(async (event): Promise<SetupHealth> => {
  setHeader(event, 'Cache-Control', 'no-store')
  let env
  try {
    env = cf(event).env
  }
  catch {
    return {
      version: serverVersion(),
      authMode: 'builtin',
      ok: false,
      ready: false,
      migrated: false,
      ownerSetup: false,
      ownerEmailHint: null,
      ...readAppBranding(),
    }
  }

  let migrated = false
  let users = 0
  let ready = false
  if (env.DB) {
    try {
      migrated = await schemaCurrent(env.DB)
      ;[users, ready] = await Promise.all([userCount(env.DB), serverReady(env.DB)])
    }
    catch {
      users = 0
    }
  }
  const ownerSetup = migrated && !ready ? await readOwnerSetup(env.DB, env, { persist: false }).catch(() => null) : null
  const branding = readAppBranding(env)
  const origin = await requestServerOrigin(env, getRequestURL(event).origin, '')
  const appearance = migrated ? await publicServerAppearance(env.DB, origin, branding.appName) : null

  const health: SetupHealth = {
    version: serverVersion(env),
    authMode: authMode(env),
    ok: Boolean(env.DB) && migrated,
    ready,
    migrated,
    ownerSetup: Boolean(ownerSetup),
    ownerEmailHint: ownerSetup ? maskedOwnerEmail(ownerSetup.email) : null,
    ...branding,
    ...(appearance ? { appName: appearance.name, iconUrl: appearance.iconUrl } : {}),
  }
  if (!ready) {
    // Unclaimed Server: the setup page and installer need these to explain a
    // misconfigured deployment or decide whether owner setup is pending.
    Object.assign(health, { users, adminEnv: Boolean(readAdminEnv(env)), bindings: readBindings(env) })
  }
  if (ready && await signedIn(event)) Object.assign(health, await runtimeDetails(env, migrated, users))
  return health
})
