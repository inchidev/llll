import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit'
import type { LiveKind, LiveState } from '~~/shared/types'
import { LIVE_RING_TIMEOUT_MS, liveEndedTitle, liveTitle } from '~~/shared/live'
import type { ServerLiveChangedEvent } from '~~/shared/server-realtime'
import type { LiveJoinOptions } from '../composables/useLiveSession'
import { liveJoinProblem, liveMediaProblem, type LiveMediaControl } from '../utils/live-errors'

/** `reconnecting` keeps the person in the room while a dropped media connection is restored. */
type Conn = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'error'

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
  /** When the Call stops ringing, in this device's clock. */
  ringUntil: number
}

/** Waits before each attempt to restore a dropped media connection; then the person rejoins by hand. */
export const LIVE_RECONNECT_DELAYS_MS = [1_000, 3_000, 7_000, 15_000]

/** The media key of the person's own tile. */
export const LIVE_SELF_MEDIA_KEY = 'self'

type JoinContext = { channelId: string; title: string; kind: LiveKind }

function statusOf(error: unknown): number {
  return error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode) : 0
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
  /** In a room, including while its dropped media connection is being restored. */
  const inRoom = computed(() => connection.value === 'connected' || connection.value === 'reconnecting')
  const error = ref<string | null>(null)
  /** What failed: the connection, or one control such as the camera. */
  const errorTitle = ref<string | null>(null)
  const meeting = shallowRef<LiveMeeting | null>(null)
  const selfParticipant = shallowRef<RTKSelf | null>(null)
  const remoteParticipants = shallowRef<RTKParticipant[]>([])
  const activeSpeakerId = ref<string | null>(null)
  /** Bumped per participant when their media changes, so only their tile re-attaches. */
  const mediaRevisions = shallowRef<Record<string, number>>({})
  const incoming = ref<IncomingLive | null>(null)
  const pendingJoin = ref<{ channelId: string } | null>(null)
  /** A short message for the person when their room ends or they are removed. */
  const notice = ref<string | null>(null)
  let cleanupMeetingEvents: (() => void) | null = null
  let cleanupParticipantEvents: (() => void) | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let currentMeetingId: string | null = null
  let lastJoinOptions: LiveJoinOptions | null = null
  let joining: Promise<void> | null = null
  /** Changes whenever the person leaves, so a pending reconnect stops. */
  let reconnectRun = 0

  function view(channelId: string) {
    viewingChannelId.value = channelId
  }

  function stateFor(channelId: string): LiveState | null {
    return states.value[channelId] ?? null
  }

  function setError(title: string | null, message: string | null) {
    errorTitle.value = message ? title : null
    error.value = message
  }

  function setState(channelId: string, next: LiveState | null) {
    if (!channelId) return
    if (next) states.value = { ...states.value, [channelId]: next }
    else {
      const { [channelId]: _removed, ...rest } = states.value
      states.value = rest
    }
    // Stop ringing once the Call ended or was answered, including on another device.
    if (next && (!next.active || !next.ringing) && incoming.value?.channelId === channelId) incoming.value = null
    // The room ended for everyone: leave the media quietly instead of reporting a failure.
    if (next && !next.active && currentChannelId.value === channelId && (meeting.value || connection.value === 'reconnecting')) {
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

  function bumpMedia(key: string) {
    mediaRevisions.value = { ...mediaRevisions.value, [key]: (mediaRevisions.value[key] ?? 0) + 1 }
  }

  function mediaRevisionOf(key: string): number {
    return mediaRevisions.value[key] ?? 0
  }

  /** Re-read who is in the room. Tiles of people who stay keep their attached media. */
  function syncParticipants() {
    const active = meeting.value
    selfParticipant.value = active?.self ? markRaw(active.self) : null
    remoteParticipants.value = (active?.participants.joined.toArray() ?? []).map(participant => markRaw(participant))
    cleanupParticipantEvents?.()
    const subscriptions = remoteParticipants.value.map((participant) => {
      const source = participant as unknown as MeetingEventSource
      const updateMedia = () => {
        silenceIfDeafened()
        bumpMedia(participant.id)
      }
      for (const event of ['videoUpdate', 'audioUpdate', 'screenShareUpdate']) source.on(event, updateMedia)
      return () => {
        for (const event of ['videoUpdate', 'audioUpdate', 'screenShareUpdate']) source.off(event, updateMedia)
      }
    })
    silenceIfDeafened()
    cleanupParticipantEvents = () => {
      for (const unsubscribe of subscriptions) unsubscribe()
    }
  }

  function syncSelf() {
    const active = meeting.value
    selfParticipant.value = active?.self ? markRaw(active.self) : null
    bumpMedia(LIVE_SELF_MEDIA_KEY)
  }

  function attachMeeting(next: LiveMeeting, context: JoinContext) {
    cleanupMeetingEvents?.()
    meeting.value = markRaw(next)
    currentChannelId.value = context.channelId
    currentTitle.value = context.title
    currentKind.value = context.kind
    const joined = next.participants.joined
    const participants = next.participants
    const self = next.self as unknown as MeetingEventSource
    const sync = () => syncParticipants()
    const onSelfMedia = () => syncSelf()
    const onSpeaker = (...args: unknown[]) => {
      const payload = args[0] as { peerId?: string } | undefined
      activeSpeakerId.value = payload?.peerId ?? null
    }
    const onRoomLeft = (...args: unknown[]) => {
      if (meeting.value !== next) return
      const reason = (args[0] as { state?: string } | undefined)?.state
      if (reason === 'left') return
      // RealtimeKit removes everyone when the room ends and removes one person when they lose access.
      if (reason === 'ended' || states.value[context.channelId]?.active === false) {
        endLocal(liveEndedTitle(context.kind))
        return
      }
      if (reason === 'kicked') {
        void explainRemoval(context.channelId)
        return
      }
      if (reason === 'rejected') {
        endLocal(null)
        connection.value = 'error'
        setError('Live connection problem', 'The live session did not let you in. Try joining again.')
        return
      }
      void reconnect(context)
    }
    const joinedEvents = ['participantJoined', 'participantLeft', 'participantsUpdate', 'participantsCleared']
    const selfEvents = ['videoUpdate', 'audioUpdate', 'screenShareUpdate', 'deviceUpdate']
    for (const event of joinedEvents) joined.on(event, sync)
    for (const event of selfEvents) self.on(event, onSelfMedia)
    self.on('roomLeft', onRoomLeft)
    participants.on('activeSpeaker', onSpeaker)
    cleanupMeetingEvents = () => {
      for (const event of joinedEvents) joined.off(event, sync)
      for (const event of selfEvents) self.off(event, onSelfMedia)
      self.off('roomLeft', onRoomLeft)
      participants.off('activeSpeaker', onSpeaker)
    }
    syncParticipants()
    syncSelf()
  }

  /**
   * RealtimeKit reports both a removal and a seat replaced by the same person
   * joining from another tab or device as `kicked`. The room still has a seat
   * for them only in the second case.
   */
  async function explainRemoval(channelId: string) {
    endLocal(null)
    let replaced = false
    try {
      replaced = (await plainFetch<{ joined: boolean }>(`/api/channels/${channelId}/live/heartbeat`, { method: 'POST' })).joined
    }
    catch { /* someone who lost access cannot ask, and was removed */ }
    notice.value = replaced ? 'You joined from another tab or device' : 'You were removed from the live session'
  }

  /** Forget the media session but keep which room this is, for a reconnect. */
  function detachMeeting() {
    cleanupMeetingEvents?.()
    cleanupMeetingEvents = null
    cleanupParticipantEvents?.()
    cleanupParticipantEvents = null
    meeting.value = null
    selfParticipant.value = null
    remoteParticipants.value = []
    activeSpeakerId.value = null
    mediaRevisions.value = {}
  }

  function clearMeeting() {
    reconnectRun += 1
    detachMeeting()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    currentChannelId.value = null
    currentTitle.value = null
    currentMeetingId = null
    // Mute and deafen are the person's preferences, not per-call state: they carry
    // into the next call instead of resetting when this one ends.
    camera.value = false
    screenSharing.value = false
    connection.value = 'idle'
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    const heartbeat = async () => {
      const channelId = currentChannelId.value
      if (!channelId || connection.value !== 'connected') return
      try {
        const { joined } = await plainFetch<{ joined: boolean }>(`/api/channels/${channelId}/live/heartbeat`, { method: 'POST' })
        if (!joined && currentChannelId.value === channelId && connection.value === 'connected') endLocal('You are no longer in this live session')
      }
      catch { /* the room expires stale presence when connectivity does not recover */ }
    }
    heartbeatTimer = setInterval(() => { void heartbeat() }, 15_000)
    void heartbeat()
  }

  async function notifyLeave(channelId: string) {
    try { await plainFetch(`/api/channels/${channelId}/live/leave`, { method: 'POST' }) }
    catch { /* leaving the media is what the other participants see */ }
  }

  /**
   * Take a seat and connect its media. With `rejoinMeetingId`, only the same
   * meeting is joined again: a room that ended is never started anew, and a
   * failed attempt keeps the seat for the next one instead of leaving, which
   * would hang up a Call.
   */
  async function openMeeting(channelId: string, options: LiveJoinOptions, rejoinMeetingId?: string) {
    let activeMeeting: LiveMeeting | null = null
    let seated = false
    try {
      const response = await plainFetch<{ token: string; meetingId: string; live: LiveState }>(`/api/channels/${channelId}/live`, {
        method: 'POST',
        ...(rejoinMeetingId ? { body: { meetingId: rejoinMeetingId } } : {}),
      })
      seated = true
      setState(channelId, response.live)
      const RealtimeKitClient = (await import('@cloudflare/realtimekit')).default
      const next = await RealtimeKitClient.init({
        authToken: response.token,
        defaults: { audio: options.audio, video: options.video },
      }) as unknown as LiveMeeting
      activeMeeting = next
      await next.join()
      currentMeetingId = response.meetingId
      lastJoinOptions = options
      muted.value = !options.audio
      camera.value = options.video
      screenSharing.value = false
      attachMeeting(next, {
        channelId,
        title: options.title || liveTitle(response.live.kind),
        kind: response.live.kind,
      })
      await Promise.allSettled([
        ...(options.audioInputId ? [setDevice('audioinput', options.audioInputId)] : []),
        ...(options.videoInputId ? [setDevice('videoinput', options.videoInputId)] : []),
        ...(options.audioOutputId ? [setDevice('audiooutput', options.audioOutputId)] : []),
      ])
      try { await next.audio.play() }
      catch { /* browser may require another gesture; media controls remain available */ }
      connection.value = 'connected'
      setError(null, null)
      startHeartbeat()
    }
    catch (cause) {
      try { await activeMeeting?.leave() }
      catch { /* initialization may have failed before joining */ }
      if (activeMeeting && meeting.value === activeMeeting) detachMeeting()
      if (seated && !rejoinMeetingId) await notifyLeave(channelId)
      throw cause
    }
  }

  /** Join a room, starting it when idle. A second call while joining waits for the first instead of taking another seat. */
  function join(channelId: string, options: LiveJoinOptions): Promise<void> {
    if (joining) return joining
    if (currentChannelId.value === channelId && (connection.value === 'connected' || connection.value === 'reconnecting')) {
      return Promise.resolve()
    }
    const run = (async () => {
      try {
        if (meeting.value || currentChannelId.value) await hangup()
        connection.value = 'connecting'
        setError(null, null)
        await openMeeting(channelId, options)
      }
      catch (cause) {
        clearMeeting()
        connection.value = 'error'
        setError('Could not connect', liveJoinProblem(cause))
        throw cause
      }
      finally {
        joining = null
      }
    })()
    joining = run
    return run
  }

  /** Leave the room this person is in, telling the server unless the room already ended. */
  async function hangup(notify = true) {
    const channelId = currentChannelId.value
    const active = meeting.value
    clearMeeting()
    try { await active?.leave() }
    catch { /* already disconnected */ }
    if (notify && channelId) await notifyLeave(channelId)
  }

  /**
   * Restore a media connection that dropped without anyone leaving: take a
   * fresh token for the same meeting and keep the mic and camera as they were.
   * After a few attempts the person sees why and can join again by hand.
   */
  async function reconnect(context: JoinContext) {
    const run = ++reconnectRun
    const dropped = meeting.value
    const meetingId = currentMeetingId
    const options: LiveJoinOptions = { ...lastJoinOptions, audio: !muted.value, video: camera.value, title: context.title, kind: context.kind }
    detachMeeting()
    void dropped?.leave().catch(() => { /* already disconnected */ })
    screenSharing.value = false
    connection.value = 'reconnecting'
    setError(null, null)
    for (const delay of LIVE_RECONNECT_DELAYS_MS) {
      await new Promise(resolve => setTimeout(resolve, delay))
      if (run !== reconnectRun) return
      if (states.value[context.channelId]?.active === false || !meetingId) {
        endLocal(liveEndedTitle(context.kind))
        return
      }
      try {
        await openMeeting(context.channelId, options, meetingId)
        // They left while this attempt was connecting.
        if (run !== reconnectRun) await hangup()
        return
      }
      catch (cause) {
        if (run !== reconnectRun) return
        const status = statusOf(cause)
        // The room ended, or this person can no longer open the conversation.
        if (status === 403 || status === 404) {
          endLocal(status === 404 ? liveEndedTitle(context.kind) : 'You are no longer in this live session')
          return
        }
      }
    }
    if (run !== reconnectRun) return
    clearMeeting()
    await notifyLeave(context.channelId)
    connection.value = 'error'
    setError('Live connection problem', 'The live connection dropped and could not be restored. Join again when your connection is back.')
  }

  function reportMedia(control: LiveMediaControl, cause: unknown) {
    const problem = liveMediaProblem(control, cause)
    if (problem) setError(problem.title, problem.message)
  }

  async function applyMute(next: boolean) {
    try {
      if (meeting.value?.self) {
        if (next) await meeting.value.self.disableAudio()
        else await meeting.value.self.enableAudio()
      }
      muted.value = next
      setError(null, null)
      syncSelf()
    }
    catch (cause) {
      reportMedia('microphone', cause)
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
      setError(null, null)
      syncSelf()
    }
    catch (cause) {
      reportMedia('camera', cause)
    }
  }

  async function toggleScreenShare() {
    if (!meeting.value?.self) return
    try {
      if (screenSharing.value) await meeting.value.self.disableScreenShare()
      else await meeting.value.self.enableScreenShare()
      screenSharing.value = !screenSharing.value
      setError(null, null)
      syncSelf()
    }
    catch (cause) {
      // Closing the screen picker is not a failure.
      reportMedia('screen', cause)
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

  /** A host turns off someone's microphone. RealtimeKit allows it only with the host preset. */
  async function muteParticipant(participant: RTKParticipant) {
    try {
      await participant.disableAudio()
      setError(null, null)
    }
    catch {
      setError('Could not mute', `${participant.name || 'This participant'} could not be muted. Try again.`)
    }
  }

  /** A host removes someone from the room. The server checks that this person is a host. */
  async function removeParticipant(participant: RTKParticipant) {
    const channelId = currentChannelId.value
    const userId = participant.customParticipantId
    if (!channelId || !userId) return
    try {
      const response = await plainFetch<{ live: LiveState }>(`/api/channels/${channelId}/live/remove`, { method: 'POST', body: { userId } })
      setState(channelId, response.live)
      setError(null, null)
    }
    catch (cause) {
      setError('Could not remove', liveJoinProblem(cause))
    }
  }

  function receiveLive(event: ServerLiveChangedEvent) {
    if (event.outcome && currentChannelId.value === event.channelId && (meeting.value || connection.value === 'reconnecting')) {
      endLocal(event.outcome === 'declined' ? 'Call declined' : 'No answer')
    }
    setState(event.channelId, event.live)
    if (!event.live.active || currentChannelId.value === event.channelId || !event.ring || !event.notification) return
    const started = event.live.startedAt ? Date.parse(event.live.startedAt) : Number.NaN
    // Trust the server's start time only as far as this device's clock agrees.
    const ringUntil = Math.min(Date.now() + LIVE_RING_TIMEOUT_MS, Number.isFinite(started) ? started + LIVE_RING_TIMEOUT_MS : Number.POSITIVE_INFINITY)
    incoming.value = {
      channelId: event.channelId,
      title: event.notification.title,
      body: event.notification.body,
      ringUntil,
    }
  }

  /** Answer a ringing Call. Someone in another room leaves it explicitly first. */
  async function answerIncoming() {
    if (!incoming.value) return
    const channelId = incoming.value.channelId
    incoming.value = null
    if (currentChannelId.value && currentChannelId.value !== channelId) await hangup()
    pendingJoin.value = { channelId }
    void navigateTo(`/channels/${channelId}`)
  }

  /** Stop ringing here. The Call keeps ringing elsewhere and can still be joined. */
  function ignoreIncoming() {
    incoming.value = null
  }

  async function declineIncoming() {
    const call = incoming.value
    incoming.value = null
    if (!call) return
    try { await plainFetch(`/api/channels/${call.channelId}/live/decline`, { method: 'POST' }) }
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
    inRoom,
    error,
    errorTitle,
    meeting,
    selfParticipant,
    remoteParticipants,
    activeSpeakerId,
    mediaRevisions,
    incoming,
    pendingJoin,
    notice,
    view,
    stateFor,
    setState,
    setError,
    attachMeeting,
    clearMeeting,
    startHeartbeat,
    syncParticipants,
    mediaRevisionOf,
    join,
    hangup,
    applyMute,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreenShare,
    setDevice,
    muteParticipant,
    removeParticipant,
    receiveLive,
    answerIncoming,
    ignoreIncoming,
    declineIncoming,
    endLocal,
  }
})
