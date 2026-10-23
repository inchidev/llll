import { getServerId } from '../shared/server-id'
import { cloudflareApiToken } from './cloudflare-rest'
import { asRpc, callsProvider, type L4Env } from './env'
import type { RestRealtimeKitApp } from './realtimekit-rest'
import {
  addParticipant,
  createMeeting,
  endMeeting,
  RealtimeKitHttpError,
  loadRealtimeKitConfig,
  realtimekitConfigured,
  removeParticipants,
  type RealtimeKitParticipant,
  type RealtimeKitRuntimeConfig,
} from './realtimekit'

/**
 * The media plane behind a Live room. The Channel Durable Object decides who
 * may join and who is a host; this only creates meetings and seats in them.
 * Today it talks to RealtimeKit with the server's own credential.
 */
export type LiveMedia = {
  createMeeting: (title: string) => Promise<{ id: string }>
  addParticipant: (meetingId: string, seat: { name: string, customId: string, host: boolean }) => Promise<RealtimeKitParticipant>
  removeParticipants: (meetingId: string, participantIds: string[]) => Promise<void>
  endMeeting: (meetingId: string) => Promise<void>
}

/**
 * The media plane for this server, or null when Live is not connected.
 * Credentials come from server deployment bindings or encrypted server settings.
 */
function mediaFor(config: Pick<RealtimeKitRuntimeConfig, 'accountId' | 'appId' | 'apiToken' | 'hostPreset' | 'participantPreset'>): LiveMedia {
  return {
    createMeeting: title => createMeeting(config, title),
    addParticipant: (meetingId, seat) => addParticipant(config, meetingId, {
      name: seat.name,
      customId: seat.customId,
      preset: seat.host ? config.hostPreset : config.participantPreset,
    }),
    removeParticipants: (meetingId, participantIds) => removeParticipants(config, meetingId, participantIds),
    endMeeting: meetingId => endMeeting(config, meetingId),
  }
}

async function restMedia(env: L4Env): Promise<LiveMedia | null> {
  const apiToken = cloudflareApiToken(env)
  if (!apiToken) return null
  const server = asRpc<{ restRealtimeKitApp: (failedRevision?: string) => Promise<RestRealtimeKitApp | null> }>(
    env.SERVER_DO.getByName(`server:${await getServerId(env.DB)}`),
  )
  const app = await server.restRealtimeKitApp()
  if (!app) return null
  let currentApp = app
  const token = apiToken
  const currentMedia = () => mediaFor({ ...currentApp, apiToken: token })

  // Repair only after a definite 404, once. Never replay failed writes on
  // auth/network/provider errors, or move an existing meeting to another app.
  async function withRepair<T>(action: (media: LiveMedia) => Promise<T>, existingMeeting = false): Promise<T> {
    const failedApp = currentApp
    try { return await action(currentMedia()) }
    catch (error) {
      if (!(error instanceof RealtimeKitHttpError) || error.status !== 404) throw error
      const repaired = await server.restRealtimeKitApp(failedApp.revision)
      if (!repaired || (existingMeeting && repaired.appId !== failedApp.appId)) throw error
      currentApp = repaired
      return action(currentMedia())
    }
  }
  return {
    createMeeting: title => withRepair(next => next.createMeeting(title)),
    addParticipant: (meetingId, seat) => withRepair(next => next.addParticipant(meetingId, seat), true),
    removeParticipants: (meetingId, participantIds) => currentMedia().removeParticipants(meetingId, participantIds),
    endMeeting: meetingId => currentMedia().endMeeting(meetingId),
  }
}

export async function liveMedia(env: L4Env): Promise<LiveMedia | null> {
  const config = await loadRealtimeKitConfig(env)
  if (realtimekitConfigured(config)) return mediaFor(config)
  if (callsProvider(env) !== 'realtimekit-rest') return null
  return restMedia(env)
}
