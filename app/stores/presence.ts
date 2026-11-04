import { defineStore } from 'pinia'
import type { AgentTurnDTO, PresenceStatus } from '~~/shared/types'

export const usePresenceStore = defineStore('presence', () => {
  const byUser = ref<Record<string, PresenceStatus>>({})
  const selfUserId = ref<string | null>(null)
  const typing = ref<Record<string, Record<string, boolean>>>({})
  const agentTurns = ref<Record<string, Record<string, AgentTurnDTO[]>>>({})
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

  function statusOf(userId: string): PresenceStatus {
    const agentActive = Object.values(agentTurns.value).some(channel => Boolean(channel[userId]?.length))
    return agentActive ? 'online' : byUser.value[userId] ?? (userId === selfUserId.value ? 'online' : 'offline')
  }

  function setSelf(userId: string | null) {
    selfUserId.value = userId
  }

  return { byUser, typing, agentTurns, apply, markTyping, typingIn, setAgentTurns, hydrateAgentTurns, agentTurnsIn, agentsActiveIn, statusOf, setSelf }
})
