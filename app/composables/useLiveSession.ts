import type { LiveKind, LiveState } from '~~/shared/types'
import { liveTitle } from '~~/shared/live'
import type { LiveMeeting } from '../stores/live'

export type LiveJoinOptions = {
  audio: boolean
  video: boolean
  audioInputId?: string
  videoInputId?: string
  audioOutputId?: string
  title?: string
  kind?: LiveKind
}

/**
 * Join, leave, and end one conversation's Live room. Joining starts the room
 * when it is idle; the server decides whether this member may start it.
 */
export function useLiveSession(
  channelId: MaybeRefOrGetter<string>,
  opts: { leaveOnUnmount?: boolean } = {},
) {
  const live = useLiveStore()
  const ui = useUiStore()

  async function notifyLeave(id: string) {
    try { await $fetch(`/api/channels/${id}/live/leave`, { method: 'POST' }) }
    catch { /* leaving the media is what the other participants see */ }
  }

  async function hangupLocal(notify = true) {
    const id = live.currentChannelId
    const meeting = live.meeting
    try { await meeting?.leave() }
    catch { /* already disconnected */ }
    live.clearMeeting()
    if (notify && id) await notifyLeave(id)
  }

  async function join(options: LiveJoinOptions) {
    const id = toValue(channelId)
    if (live.connection === 'connected' && live.currentChannelId === id) return
    if (live.meeting) await hangupLocal()
    live.connection = 'connecting'
    live.error = null
    let activeMeeting: LiveMeeting | null = null
    let seated = false
    try {
      const response = await $fetch<{ token: string; meetingId: string; live: LiveState }>(`/api/channels/${id}/live`, { method: 'POST' })
      seated = true
      live.setState(id, response.live)
      const RealtimeKitClient = (await import('@cloudflare/realtimekit')).default
      const meeting = await RealtimeKitClient.init({
        authToken: response.token,
        defaults: { audio: options.audio, video: options.video },
      }) as unknown as LiveMeeting
      activeMeeting = meeting
      await meeting.join()
      live.attachMeeting(meeting, {
        channelId: id,
        title: options.title || liveTitle(response.live.kind),
        kind: response.live.kind,
      })
      live.muted = !options.audio
      live.camera = options.video
      live.screenSharing = false
      await Promise.allSettled([
        ...(options.audioInputId ? [live.setDevice('audioinput', options.audioInputId)] : []),
        ...(options.videoInputId ? [live.setDevice('videoinput', options.videoInputId)] : []),
        ...(options.audioOutputId ? [live.setDevice('audiooutput', options.audioOutputId)] : []),
      ])
      try { await meeting.audio.play() }
      catch { /* browser may require another gesture; media controls remain available */ }
      live.connection = 'connected'
      live.startHeartbeat()
      live.expanded = true
    }
    catch (err) {
      try { await activeMeeting?.leave() }
      catch { /* initialization may have failed before joining */ }
      if (seated) await notifyLeave(id)
      live.clearMeeting()
      live.connection = 'error'
      const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
      if (code === 'realtimekit_unconfigured') ui.liveSetupOpen = true
      live.error = errorMessage(err)
      throw err
    }
  }

  async function leave() {
    await hangupLocal()
  }

  /** End the room for everyone. Only hosts can; the server checks. */
  async function end() {
    const id = toValue(channelId)
    const response = await $fetch<{ live: LiveState }>(`/api/channels/${id}/live`, { method: 'DELETE' })
    await hangupLocal(false)
    live.setState(id, response.live)
  }

  if (opts.leaveOnUnmount !== false) {
    onUnmounted(() => {
      if (live.connection === 'connected') void hangupLocal()
    })
  }

  return {
    join,
    leave,
    end,
    toggleMute: live.toggleMute,
    toggleCamera: live.toggleCamera,
    toggleScreenShare: live.toggleScreenShare,
  }
}
