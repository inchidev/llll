import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit'
import type { LiveKind, LiveState } from '~~/shared/types'
import { liveEndedTitle } from '~~/shared/live'
import type { WorkspaceLiveChangedEvent } from '~~/shared/workspace-realtime'

type Conn = 'idle' | 'connecting' | 'connected' | 'error'

type MeetingEventSource = {
  on: (event: string, callback: (...args: unknown[]) => void) => unknown
  off: (event: string, callback: (...args: unknown[]) => void) => unknown
}

export type LiveMeeting = {
  join: () => Promise<void>
  leave: () => Promise<void>
  self: RTKSelf
  participants: {
    joined: MeetingEventSource & { toArray: () => RTKParticipant[] }
    on: (event: string, callback: (...args: unknown[]) => void) => unknown
    off: (event: string, callback: (...args: unknown[]) => void) => unknown
  }
  audio: { setSpeakerDevice: (deviceId: string) => void; play: () => Promise<void> }
}

export type IncomingLive = {
  channelId: string
  title: string
  body: string
}

export const useLiveStore = defineStore('live', () => {
  const states = ref<Record<string, LiveState>>({})
  const viewingChannelId = ref('')
  const state = computed(() => states.value[viewingChannelId.value] ?? null)
  const currentChannelId = ref<string | null>(null)
  const currentTitle = ref<string | null>(null)
  const currentKind = ref<LiveKind>('live')
  const muted = ref(false)
  const deafened = ref(false)
  const camera = ref(false)
  const screenSharing = ref(false)
  const expanded = ref(true)
  const connection = ref<Conn>('idle')
  const error = ref<string | null>(null)
  const meeting = shallowRef<LiveMeeting | null>(null)
  const selfParticipant = shallowRef<RTKSelf | null>(null)
  const remoteParticipants = shallowRef<RTKParticipant[]>([])
  const activeSpeakerId = ref<string | null>(null)
  const mediaRevision = ref(0)
  const incoming = ref<IncomingLive | null>(null)
  const pendingJoin = ref<{ channelId: string } | null>(null)
  /** A short message for the person when their room ends or they are removed. */
  const notice = ref<string | null>(null)
  let cleanupMeetingEvents: (() => void) | null = null
  let cleanupParticipantEvents: (() => void) | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function view(channelId: string) {
    viewingChannelId.value = channelId
  }

  function stateFor(channelId: string): LiveState | null {
    return states.value[channelId] ?? null
  }

  function setState(channelId: string, next: LiveState | null) {
    if (!channelId) return
    if (next) states.value = { ...states.value, [channelId]: next }
    else {
      const { [channelId]: _removed, ...rest } = states.value
      states.value = rest
    }
    if (next && !next.active && incoming.value?.channelId === channelId) incoming.value = null
    // The room ended for everyone: leave the media quietly instead of reporting a failure.
    if (next && !next.active && currentChannelId.value === channelId && meeting.value) {
      endLocal(liveEndedTitle(next.kind))
    }
  }

  /** Drop out of the media session without asking the server, for rooms that ended or removed us. */
  function endLocal(message: string | null) {
    const active = meeting.value
    clearMeeting()
    void active?.leave().catch(() => { /* already disconnected */ })
    if (message) notice.value = message
  }

  /** Deafen covers everyone in the call, including people who join or republish audio later. */
  function silenceIfDeafened() {
    for (const participant of remoteParticipants.value) {
      if (participant.audioTrack) participant.audioTrack.enabled = !deafened.value
    }
  }

  function syncParticipants() {
    const active = meeting.value
    selfParticipant.value = active?.self ? markRaw(active.self) : null
    remoteParticipants.value = (active?.participants.joined.toArray() ?? []).map(participant => markRaw(participant))
    cleanupParticipantEvents?.()
    const eventSources = remoteParticipants.value.map(participant => participant as unknown as MeetingEventSource)
    const updateMedia = () => {
      silenceIfDeafened()
      mediaRevision.value += 1
    }
    silenceIfDeafened()
    for (const source of eventSources) {
      source.on('videoUpdate', updateMedia)
      source.on('audioUpdate', updateMedia)
      source.on('screenShareUpdate', updateMedia)
    }
    cleanupParticipantEvents = () => {
      for (const source of eventSources) {
        source.off('videoUpdate', updateMedia)
        source.off('audioUpdate', updateMedia)
        source.off('screenShareUpdate', updateMedia)
      }
    }
    mediaRevision.value += 1
  }

  function attachMeeting(next: LiveMeeting, context: { channelId: string; title: string; kind: LiveKind }) {
    cleanupMeetingEvents?.()
    meeting.value = markRaw(next)
    currentChannelId.value = context.channelId
    currentTitle.value = context.title
    currentKind.value = context.kind
    const joined = next.participants.joined
    const participants = next.participants
    const self = next.self as unknown as MeetingEventSource
    const sync = () => syncParticipants()
    const onSpeaker = (...args: unknown[]) => {
      const payload = args[0] as { peerId?: string } | undefined
      activeSpeakerId.value = payload?.peerId ?? null
    }
    const onRoomLeft = (...args: unknown[]) => {
      if (meeting.value !== next) return
      const reason = (args[0] as { state?: string } | undefined)?.state
      if (reason === 'left') return
      // RealtimeKit removes everyone when the room ends and removes one person when they lose access.
      if (reason === 'kicked' || reason === 'ended' || states.value[context.channelId]?.active === false) {
        endLocal(reason === 'kicked' ? 'You were removed from the live session' : liveEndedTitle(context.kind))
        return
      }
      connection.value = 'error'
      error.value = 'The live connection dropped. Leave and join again to reconnect.'
    }
    const joinedEvents = ['participantJoined', 'participantLeft', 'participantsUpdate', 'participantsCleared']
    const selfEvents = ['videoUpdate', 'audioUpdate', 'screenShareUpdate', 'deviceUpdate', 'roomLeft']
    for (const event of joinedEvents) joined.on(event, sync)
    for (const event of selfEvents) self.on(event, sync)
    self.on('roomLeft', onRoomLeft)
    participants.on('activeSpeaker', onSpeaker)
    cleanupMeetingEvents = () => {
      for (const event of joinedEvents) joined.off(event, sync)
      for (const event of selfEvents) self.off(event, sync)
      self.off('roomLeft', onRoomLeft)
      participants.off('activeSpeaker', onSpeaker)
    }
    syncParticipants()
  }

  function clearMeeting() {
    cleanupMeetingEvents?.()
    cleanupMeetingEvents = null
    cleanupParticipantEvents?.()
    cleanupParticipantEvents = null
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    meeting.value = null
    selfParticipant.value = null
    remoteParticipants.value = []
    activeSpeakerId.value = null
    currentChannelId.value = null
    currentTitle.value = null
    // Mute and deafen are the person's preferences, not per-call state: they carry
    // into the next call instead of resetting when this one ends.
    camera.value = false
    screenSharing.value = false
    connection.value = 'idle'
    mediaRevision.value += 1
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    const heartbeat = async () => {
      const channelId = currentChannelId.value
      if (!channelId || connection.value !== 'connected') return
      try {
        const { joined } = await $fetch<{ joined: boolean }>(`/api/channels/${channelId}/live/heartbeat`, { method: 'POST' })
        if (!joined && currentChannelId.value === channelId) endLocal('You are no longer in this live session')
      }
      catch { /* the room expires stale presence when connectivity does not recover */ }
    }
    heartbeatTimer = setInterval(() => { void heartbeat() }, 15_000)
    void heartbeat()
  }

  async function applyMute(next: boolean) {
    try {
      if (meeting.value?.self) {
        if (next) await meeting.value.self.disableAudio()
        else await meeting.value.self.enableAudio()
      }
      muted.value = next
      error.value = null
      syncParticipants()
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Microphone control failed'
    }
  }

  async function toggleMute() {
    if (deafened.value && muted.value) return
    await applyMute(!muted.value)
  }

  // Deafening also mutes; undeafening restores whatever the mic was before.
  let mutedBeforeDeafen = false
  async function toggleDeafen() {
    const next = !deafened.value
    deafened.value = next
    silenceIfDeafened()
    if (next) {
      mutedBeforeDeafen = muted.value
      await applyMute(true)
    }
    else {
      await applyMute(mutedBeforeDeafen)
    }
  }

  async function toggleCamera() {
    if (!meeting.value?.self) return
    try {
      if (camera.value) await meeting.value.self.disableVideo()
      else await meeting.value.self.enableVideo()
      camera.value = !camera.value
      error.value = null
      syncParticipants()
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Camera control failed'
    }
  }

  async function toggleScreenShare() {
    if (!meeting.value?.self) return
    try {
      if (screenSharing.value) await meeting.value.self.disableScreenShare()
      else await meeting.value.self.enableScreenShare()
      screenSharing.value = !screenSharing.value
      error.value = null
      syncParticipants()
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Screen sharing failed'
    }
  }

  async function setDevice(kind: MediaDeviceKind, deviceId: string) {
    if (!meeting.value || !deviceId) return
    if (kind === 'audiooutput') {
      meeting.value.audio.setSpeakerDevice(deviceId)
      return
    }
    const devices = await meeting.value.self.getAllDevices()
    const device = devices.find(item => item.deviceId === deviceId && item.kind === kind)
    if (device) await meeting.value.self.setDevice(device)
  }

  function receiveLive(event: WorkspaceLiveChangedEvent) {
    if (event.outcome && currentChannelId.value === event.channelId && meeting.value) {
      endLocal(event.outcome === 'declined' ? 'Call declined' : 'No answer')
    }
    setState(event.channelId, event.live)
    if (!event.live.active || currentChannelId.value === event.channelId || !event.ring || !event.notification) return
    incoming.value = {
      channelId: event.channelId,
      title: event.notification.title,
      body: event.notification.body,
    }
  }

  function answerIncoming() {
    if (!incoming.value) return
    const channelId = incoming.value.channelId
    pendingJoin.value = { channelId }
    incoming.value = null
    void navigateTo(`/channels/${channelId}`)
  }

  async function declineIncoming() {
    const call = incoming.value
    incoming.value = null
    if (!call) return
    try { await $fetch(`/api/channels/${call.channelId}/live/decline`, { method: 'POST' }) }
    catch { /* the call still stops ringing when it times out */ }
  }

  return {
    states,
    state,
    viewingChannelId,
    currentChannelId,
    currentTitle,
    currentKind,
    muted,
    deafened,
    camera,
    screenSharing,
    expanded,
    connection,
    error,
    meeting,
    selfParticipant,
    remoteParticipants,
    activeSpeakerId,
    mediaRevision,
    incoming,
    pendingJoin,
    notice,
    view,
    stateFor,
    setState,
    attachMeeting,
    clearMeeting,
    startHeartbeat,
    syncParticipants,
    applyMute,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreenShare,
    setDevice,
    receiveLive,
    answerIncoming,
    declineIncoming,
    endLocal,
  }
})
