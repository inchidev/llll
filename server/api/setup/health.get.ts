import { liveAvailable } from '../../../workers/realtimekit'
import { ensureAdminFromEnv, readAdminEnv } from '../../utils/bootstrap'
import { cf } from '../../utils/cf'
import { ensureMigrated, userCount, serverReady } from '../../utils/db'
import type { SetupHealth } from '../../../shared/types'
import { readAppBranding } from '../../../shared/app-branding'
import { maskedOwnerEmail, readOwnerSetup } from '../../utils/owner-setup'
import { serverVersion } from '../../utils/version'
import { publicServerAppearance } from '../../utils/server-appearance'
import { ensurePrimaryServerOrigin, primaryServerOrigin } from '../../utils/server-origins'
import { authMode } from '../../utils/cloudflare-access'
import { agentBrowserConfigured, aiProvider } from '../../../workers/env'
import { serverAiModel, serverCapabilities, UNAVAILABLE_CAPABILITIES } from '../../../workers/server-capabilities'

export default defineEventHandler(async (event): Promise<SetupHealth> => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Access-Control-Allow-Origin', '*')
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
      users: 0,
      migrated: false,
      adminEnv: false,
      ownerSetup: false,
      ownerEmailHint: null,
      bindings: { db: false, r2: false, kv: false, channelDo: false, serverDo: false, rateLimitDo: false, notificationDo: false, agentDo: false, workersAi: false, browser: false },
      aiProvider: null,
      aiModel: null,
      capabilities: UNAVAILABLE_CAPABILITIES,
      realtimekit: false,
      twitterAuth: false,
      ...readAppBranding(),
    }
  }

  const bindings = {
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
  const provider = aiProvider(env)

  let migrated = false
  let users = 0
  let ready = false
  const checkFiles = env.FILES
    ? env.FILES.head('__health__').catch(() => {
        // head of missing key still proves the binding works on most runtimes
      })
    : null
  const realtimekit = liveAvailable(env)
  if (env.DB) {
    try {
      migrated = await ensureMigrated(env.DB, env)
      users = (await ensureAdminFromEnv(event)).users
      ready = await serverReady(env.DB)
    }
    catch {
      try {
        ;[users, ready] = await Promise.all([userCount(env.DB), serverReady(env.DB)])
      }
      catch {
        users = 0
      }
    }
  }

  const ownerSetup = await readOwnerSetup(env.DB, env)
  await checkFiles
  const requestOrigin = getRequestURL(event).origin
  if (migrated) await ensurePrimaryServerOrigin(env, requestOrigin)
  const primaryOrigin = migrated ? await primaryServerOrigin(env, requestOrigin) : env.PUBLIC_ORIGIN || requestOrigin
  const branding = readAppBranding(env)
  const appearance = migrated ? await publicServerAppearance(env.DB, primaryOrigin, branding.appName) : null

  return {
    version: serverVersion(env),
    authMode: authMode(env),
    ok: bindings.db && migrated,
    ready,
    users,
    migrated,
    adminEnv: Boolean(readAdminEnv(env)),
    ownerSetup: Boolean(ownerSetup && !ready),
    ownerEmailHint: ownerSetup && !ready ? maskedOwnerEmail(ownerSetup.email) : null,
    bindings,
    aiProvider: provider,
    aiModel: serverAiModel(env),
    capabilities: serverCapabilities(env),
    realtimekit: await realtimekit,
    twitterAuth: Boolean(env.TWITTER_CLIENT_ID?.trim() && env.TWITTER_CLIENT_SECRET?.trim()),
    ...branding,
    ...(appearance ? { appName: appearance.name, iconUrl: appearance.iconUrl } : {}),
  }
})
