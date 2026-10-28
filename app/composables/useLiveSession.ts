import type { LiveKind, LiveState } from '~~/shared/types'

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

  async function join(options: LiveJoinOptions) {
    try {
      await live.join(toValue(channelId), options)
    }
    catch (err) {
      const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
      if (code === 'realtimekit_unconfigured') ui.liveSetupOpen = true
      throw err
    }
  }

  async function leave() {
    await live.hangup()
  }

  /** End the room for everyone. Only hosts can; the server checks. */
  async function end() {
    const id = toValue(channelId)
    const response = await $fetch<{ live: LiveState }>(`/api/channels/${id}/live`, { method: 'DELETE' })
    await live.hangup(false)
    live.setState(id, response.live)
  }

  if (opts.leaveOnUnmount !== false) {
    onUnmounted(() => {
      if (live.connection === 'connected' || live.connection === 'reconnecting') void live.hangup()
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
