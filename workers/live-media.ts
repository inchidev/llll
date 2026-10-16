import { cloudflareAccountId, cloudflareApiToken } from './cloudflare-rest'
import { callsProvider, type L4Env } from './env'
import { llllAdmin } from './llll-admin'
import {
  addParticipant,
  createMeeting,
  LLLL_HOST_PRESET,
  LLLL_PARTICIPANT_PRESET,
  endMeeting,
  ensureLivePresets,
  findOrCreateApp,
  loadRealtimeKitConfig,
  realtimekitConfigured,
  removeParticipants,
  type RealtimeKitParticipant,
  type RealtimeKitRuntimeConfig,
} from './realtimekit'

/**
 * The media plane behind a Live room. The Channel Durable Object decides who
 * may join and who is a host; this only creates meetings and seats in them.
 * Today it talks to RealtimeKit with the installation's own credential.
 */
export type LiveMedia = {
  createMeeting: (title: string) => Promise<{ id: string }>
  addParticipant: (meetingId: string, seat: { name: string, customId: string, host: boolean }) => Promise<RealtimeKitParticipant>
  removeParticipants: (meetingId: string, participantIds: string[]) => Promise<void>
  endMeeting: (meetingId: string) => Promise<void>
}

/**
 * The media plane for this installation, or null when Live is not connected.
 * A workspace linked to a L4 Admin uses the Admin's RealtimeKit app and
 * holds no credential; otherwise it uses the token pasted in Workspace Settings.
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
  const accountId = cloudflareAccountId(env)
  const apiToken = cloudflareApiToken(env)
  if (!accountId || !apiToken) return null
  const appId = await findOrCreateApp(apiToken, accountId, env.APP_NAME?.trim() || 'L4')
  await ensureLivePresets(apiToken, accountId, appId)
  return mediaFor({
    accountId,
    appId,
    apiToken,
    hostPreset: LLLL_HOST_PRESET,
    participantPreset: LLLL_PARTICIPANT_PRESET,
  })
}

export async function liveMedia(env: L4Env): Promise<LiveMedia | null> {
  const admin = llllAdmin(env)
  if (admin) {
    return {
      createMeeting: title => admin.liveCreateMeeting(title),
      addParticipant: (meetingId, seat) => admin.liveAddParticipant(meetingId, seat),
      removeParticipants: (meetingId, participantIds) => admin.liveRemoveParticipants(meetingId, participantIds),
      endMeeting: meetingId => admin.liveEndMeeting(meetingId),
    }
  }
  const config = await loadRealtimeKitConfig(env)
  if (realtimekitConfigured(config)) return mediaFor(config)
  if (callsProvider(env) !== 'realtimekit-rest') return null
  return restMedia(env)
}
