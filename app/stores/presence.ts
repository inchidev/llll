import { defineStore } from 'pinia'
import type { AgentStreamDTO, AgentTurnDTO, PresenceStatus } from '~~/shared/types'

export const usePresenceStore = defineStore('presence', () => {
  const byUser = ref<Record<string, PresenceStatus>>({})
  const selfUserId = ref<string | null>(null)
  const typing = ref<Record<string, Record<string, boolean>>>({})
  const agentTurns = ref<Record<string, Record<string, AgentTurnDTO[]>>>({})
  /** Answers being written, by conversation and Run. They exist only on the socket. */
  const agentStreams = ref<Record<string, Record<string, AgentStreamDTO>>>({})
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function apply(users: Array<{ userId: string; status: PresenceStatus }>) {
    const next: Record<string, PresenceStatus> = {}
    for (const u of users) next[u.userId] = u.status
    byUser.value = next
  }

  function markTyping(channelId: string, userId: string, active = true) {
    const key = `${channelId}:${userId}`
    const previous = typingTimers.get(key)
    if (previous) clearTimeout(previous)
    if (!active) {
      const nextChannel = Object.fromEntries(
        Object.entries(typing.value[channelId] ?? {}).filter(([id]) => id !== userId),
      )
      typing.value = { ...typing.value, [channelId]: nextChannel }
      typingTimers.delete(key)
      return
    }
    const channel = { ...(typing.value[channelId] ?? {}), [userId]: true }
    typing.value = { ...typing.value, [channelId]: channel }
    typingTimers.set(key, setTimeout(() => {
      const nextChannel = Object.fromEntries(
        Object.entries(typing.value[channelId] ?? {}).filter(([id]) => id !== userId),
      )
      typing.value = { ...typing.value, [channelId]: nextChannel }
      typingTimers.delete(key)
    }, 3000))
  }

  function typingIn(channelId: string): string[] {
    return Object.keys(typing.value[channelId] ?? {})
  }

  function setAgentTurns(channelId: string, agentId: string, runs: AgentTurnDTO[]) {
    const current = agentTurns.value[channelId] ?? {}
    const channel = runs.length
      ? { ...current, [agentId]: runs }
      : Object.fromEntries(Object.entries(current).filter(([id]) => id !== agentId))
    agentTurns.value = { ...agentTurns.value, [channelId]: channel }
  }

  function hydrateAgentTurns(channelId: string, runs: AgentTurnDTO[]) {
    const channel: Record<string, AgentTurnDTO[]> = {}
    for (const run of runs) (channel[run.agentId] ??= []).push(run)
    agentTurns.value = { ...agentTurns.value, [channelId]: channel }
  }

  function agentTurnsIn(channelId: string): AgentTurnDTO[] {
    return Object.values(agentTurns.value[channelId] ?? {}).flat()
  }

  function agentsActiveIn(channelId: string): string[] {
    return Object.keys(agentTurns.value[channelId] ?? {})
  }

  /** `at` is the length the delta follows; a missed update waits for the next connection's snapshot. */
  function applyAgentStream(channelId: string, stream: Omit<AgentStreamDTO, 'text'>, at: number, text: string) {
    const channel = agentStreams.value[channelId] ?? {}
    const current = channel[stream.runId]
    if (at !== 0 && current?.text.length !== at) return
    agentStreams.value = { ...agentStreams.value, [channelId]: { ...channel, [stream.runId]: { ...stream, text: at === 0 ? text : current!.text + text } } }
  }

  function endAgentStream(channelId: string, runId: string) {
    const channel = agentStreams.value[channelId]
    if (!channel?.[runId]) return
    agentStreams.value = { ...agentStreams.value, [channelId]: Object.fromEntries(Object.entries(channel).filter(([id]) => id !== runId)) }
  }

  function hydrateAgentStreams(channelId: string, streams: AgentStreamDTO[]) {
    agentStreams.value = { ...agentStreams.value, [channelId]: Object.fromEntries(streams.map(stream => [stream.runId, stream])) }
  }

  function agentStreamsIn(channelId: string): AgentStreamDTO[] {
    return Object.values(agentStreams.value[channelId] ?? {}).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  function statusOf(userId: string): PresenceStatus {
    const agentActive = Object.values(agentTurns.value).some(channel => Boolean(channel[userId]?.length))
    return agentActive ? 'online' : byUser.value[userId] ?? (userId === selfUserId.value ? 'online' : 'offline')
  }

  function setSelf(userId: string | null) {
    selfUserId.value = userId
  }

  return { byUser, typing, agentTurns, agentStreams, apply, markTyping, typingIn, setAgentTurns, hydrateAgentTurns, agentTurnsIn, agentsActiveIn, applyAgentStream, endAgentStream, hydrateAgentStreams, agentStreamsIn, statusOf, setSelf }
})
