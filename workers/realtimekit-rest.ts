import { z } from 'zod'
import { DEFAULT_APP_NAME } from '../shared/app-branding'
import { readServerSetting, writeServerSetting } from '../shared/server-settings'
import { cloudflareAccountId, cloudflareApiToken } from './cloudflare-rest'
import { callsProvider, type L4Env } from './env'
import { createSerialQueue } from './serial-queue'
import { ensureLivePresets, findOrCreateApp, LLLL_HOST_PRESET, LLLL_PARTICIPANT_PRESET, RealtimeKitHttpError } from './realtimekit'

const appSchema = z.object({
  accountId: z.string().min(1),
  appId: z.string().min(1),
  hostPreset: z.literal(LLLL_HOST_PRESET),
  participantPreset: z.literal(LLLL_PARTICIPANT_PRESET),
  revision: z.string().min(1),
})

/** Non-secret provisioning metadata; the current token always comes from env. */
export type RestRealtimeKitApp = z.infer<typeof appSchema>

/** One instance owned by the Server DO serializes provisioning across all rooms. */
export class RealtimeKitRestProvisioner {
  private readonly inOrder = createSerialQueue()

  constructor(private readonly env: L4Env) {}

  private async saved(accountId: string): Promise<RestRealtimeKitApp | null> {
    const value = await readServerSetting(this.env.DB, `realtimekit_rest:${accountId}`)
    const app = value ? appSchema.parse(JSON.parse(value)) : null
    return app?.accountId === accountId ? app : null
  }

  async get(failedRevision?: string): Promise<RestRealtimeKitApp | null> {
    const accountId = cloudflareAccountId(this.env)
    const apiToken = cloudflareApiToken(this.env)
    if (callsProvider(this.env) !== 'realtimekit-rest' || !accountId || !apiToken) return null
    const ready = await this.saved(accountId)
    // Warm reads must not wait behind another room's remote repair.
    if (ready && ready.revision !== failedRevision) return ready
    return this.inOrder(async () => {
      // Another room may have finished provisioning while this one queued.
      const cached = await this.saved(accountId)
      if (cached && cached.revision !== failedRevision) return cached

      let appId = cached?.appId
      if (appId) {
        // A meeting 404 does not mean its app disappeared. Restore missing
        // presets in the existing app before considering app provisioning.
        try { await ensureLivePresets(apiToken, accountId, appId) }
        catch (error) {
          if (!(error instanceof RealtimeKitHttpError) || error.status !== 404) throw error
          appId = undefined
        }
      }
      if (!appId) {
        appId = await findOrCreateApp(apiToken, accountId, DEFAULT_APP_NAME)
        await ensureLivePresets(apiToken, accountId, appId)
      }
      const app: RestRealtimeKitApp = {
        accountId, appId,
        hostPreset: LLLL_HOST_PRESET,
        participantPreset: LLLL_PARTICIPANT_PRESET,
        revision: crypto.randomUUID(),
      }
      await writeServerSetting(this.env.DB, `realtimekit_rest:${accountId}`, JSON.stringify(app))
      return app
    })
  }
}
