import type { InfiniteData, QueryClient } from '@tanstack/vue-query'
import { ref } from 'vue'
import type { ChannelDTO, ClientMsg, MessageDTO, ServerMsg } from '~~/shared/types'
import { applyReactionChange } from '../utils/message-reactions'
import { mergeLatestPage } from '../utils/message-cache'

type Page = { messages: MessageDTO[]; nextCursor: string | null }
type ChannelList = { channels: ChannelDTO[] }
export type RealtimeConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline'

const DELIVERY_TIMEOUT_MS = 15_000
const CATCH_UP_LIMIT = 20

function keepOwnReactions(next: MessageDTO['reactions'], previous: MessageDTO['reactions']): MessageDTO['reactions'] {
  return next.map(reaction => ({
    ...reaction,
    me: previous.find(item => item.emoji === reaction.emoji)?.me ?? reaction.me,
  }))
}

export function useChannelSocket(channelId: MaybeRefOrGetter<string>) {
  const { api, socketUrl } = useApi()
  const presence = usePresenceStore()
  const live = useLiveStore()
  const nuxt = useNuxtApp()
  const connection = ref<RealtimeConnection>('connecting')

  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let connecting = false
  let generation = 0
  let authenticated = false
  const pending: ClientMsg[] = []
  const outstanding = new Map<string, Extract<ClientMsg, { t: 'message.create' }>>()
  let pendingRead: Extract<ClientMsg, { t: 'read' }> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function queryClient(): QueryClient | undefined {
    return nuxt.$queryClient as QueryClient | undefined
  }

  function applyMessage(msg: MessageDTO, mergeLiveState = false) {
    if (msg.clientId) clearDeliveryTimer(msg.clientId)
    const qc = queryClient()
    if (!qc) return
    qc.setQueryData<InfiniteData<Page>>(['messages', msg.channelId], (old) => {
      if (!old?.pages?.length) {
        return { pages: [{ messages: [msg], nextCursor: null }], pageParams: [undefined] }
      }
      const exists = old.pages.some((p) => p.messages.some((m) => m.id === msg.id || (msg.clientId && m.clientId === msg.clientId)))
      const pages = old.pages.map((p, i) => {
        if (i !== 0) return p
        if (exists) {
          const seen = new Set<string>()
          return {
            ...p,
            messages: p.messages.map((m) => {
              if (m.id !== msg.id && (!msg.clientId || m.clientId !== msg.clientId)) return m
              // Broadcast copies cannot know which reactions are this viewer's; keep ours.
              if (!mergeLiveState) return { ...msg, reactions: keepOwnReactions(msg.reactions ?? [], m.reactions ?? []) }
              return {
                ...msg,
                attachments: m.attachments,
                mentions: m.mentions,
                reactions: m.reactions,
                pin: m.pin,
                threadId: m.threadId,
              }
            // An optimistic copy and a caught-up copy can both match; keep one.
            }).filter((m) => {
              if (seen.has(m.id)) return false
              seen.add(m.id)
              return true
            }),
          }
        }
        return { ...p, messages: [...p.messages, msg] }
      })
      return { ...old, pages }
    })
    if (msg.attachments.length) void qc.invalidateQueries({ queryKey: ['files'] })
    void qc.invalidateQueries({ queryKey: ['threads'] })
  }

  function updateOptimisticMessage(clientId: string, update: (message: MessageDTO) => MessageDTO) {
    const qc = queryClient()
    if (!qc) return
    qc.setQueryData<InfiniteData<Page>>(['messages', toValue(channelId)], (old) => {
      if (!old) return old
      return {
        ...old,
        pages: old.pages.map(page => ({
          ...page,
          messages: page.messages.map(message => message.clientId === clientId ? update(message) : message),
        })),
      }
    })
  }

  function clearDeliveryTimer(clientId: string) {
    const timer = deliveryTimers.get(clientId)
    if (timer) clearTimeout(timer)
    deliveryTimers.delete(clientId)
  }

  function watchDelivery(clientId: string) {
    clearDeliveryTimer(clientId)
    deliveryTimers.set(clientId, setTimeout(() => {
      updateOptimisticMessage(clientId, message => ({ ...message, deliveryState: 'failed' }))
      deliveryTimers.delete(clientId)
    }, DELIVERY_TIMEOUT_MS))
  }

  // The socket only carries events sent while it is open. Whenever it (re)opens
  // over cached messages, fetch the newest page so anything sent in between shows up.
  async function catchUp(id: string, gen: number) {
    const qc = queryClient()
    if (!qc?.getQueryData<InfiniteData<Page>>(['messages', id])) return
    try {
      const latest = await api<Page>(`/api/channels/${id}/messages`, { query: { limit: CATCH_UP_LIMIT } })
      if (gen !== generation || !Array.isArray(latest?.messages)) return
      qc.setQueryData<InfiniteData<Page>>(['messages', id], old => mergeLatestPage(old, latest))
    }
    catch { /* the next reconnect or refetch tries again */ }
  }

  function acknowledge(clientId: string, id: string) {
    const qc = queryClient()
    if (!qc) return
    qc.setQueryData<InfiniteData<Page>>(['messages', toValue(channelId)], (old) => {
      if (!old) return old
      // A catch-up fetch may already hold the delivered copy; keep only one.
      const delivered = old.pages.some(page => page.messages.some(message => message.id === id))
      return {
        ...old,
        pages: old.pages.map(page => ({
          ...page,
          messages: delivered
            ? page.messages.filter(message => message.clientId !== clientId || message.id === id)
            : page.messages.map(message => message.clientId === clientId ? { ...message, id, deliveryState: undefined } : message),
        })),
      }
    })
  }

  function applyReadAck(channelId: string, unread: boolean) {
    const qc = queryClient()
    if (!qc) return
    let directChannel = false
    const update = (old: ChannelList | undefined) => {
      if (!old?.channels.some(channel => channel.id === channelId)) return old
      directChannel = true
      return {
        ...old,
        channels: old.channels.map(channel => channel.id === channelId
          ? { ...channel, unread, unreadCount: unread ? channel.unreadCount : 0 }
          : channel),
      }
    }
    qc.setQueriesData<ChannelList>({ queryKey: ['channels'] }, update)
    qc.setQueriesData<ChannelList>({ queryKey: ['dms'] }, update)
    if (!directChannel) {
      void qc.invalidateQueries({ queryKey: ['channels'] })
      void qc.invalidateQueries({ queryKey: ['dms'] })
    }
  }

  async function connect(gen = generation) {
    const id = toValue(channelId)
    if (!id || !import.meta.client || connecting || closed) return
    connecting = true
    connection.value = attempt ? 'reconnecting' : 'connecting'
    try {
      const { token } = await api<{ token: string }>('/api/auth/ws-token', { method: 'POST' })
      if (closed || gen !== generation) return
      const socket = new WebSocket(socketUrl(`/ws/channel/${id}`))
      ws = socket
      socket.addEventListener('open', () => {
        if (gen !== generation) return socket.close()
        attempt = 0
        socket.send(JSON.stringify({ t: 'auth', token } satisfies ClientMsg))
      })
      socket.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string' || ev.data === 'pong') return
        let parsed: ServerMsg
        try { parsed = JSON.parse(ev.data) as ServerMsg }
        catch { return }
        switch (parsed.t) {
          case 'hello':
            authenticated = true
            connection.value = 'connected'
            for (const message of outstanding.values()) socket.send(JSON.stringify(message))
            for (const queued of pending.splice(0)) socket.send(JSON.stringify(queued))
            if (pendingRead) socket.send(JSON.stringify(pendingRead))
            if (parsed.live) live.setState(id, parsed.live)
            useUiStore().dmFrozen = Boolean(parsed.frozen)
            presence.hydrateAgentTurns(id, parsed.agentTurns ?? [])
            void catchUp(id, gen)
            break
          case 'message':
            applyMessage(parsed.message)
            break
          case 'message.update':
            applyMessage(parsed.message, parsed.streaming)
            break
          case 'thread.created': {
            const qc = queryClient()
            qc?.setQueryData<InfiniteData<Page>>(['messages', id], (old) => {
              if (!old) return old
              return {
                ...old,
                pages: old.pages.map(page => ({
                  ...page,
                  messages: page.messages.map(message => message.id === parsed.messageId
                    ? { ...message, threadId: parsed.threadId }
                    : message),
                })),
              }
            })
            void qc?.invalidateQueries({ queryKey: ['threads', id] })
            break
          }
          case 'message.delete': {
            const qc = queryClient()
            qc?.setQueryData<InfiniteData<Page>>(['messages', id], (old) => {
              if (!old) return old
              return {
                ...old,
                pages: old.pages.map((p) => ({
                  ...p,
                  messages: p.messages.map((m) => m.id === parsed.id ? { ...m, deletedAt: new Date().toISOString(), content: '' } : m),
                })),
              }
            })
            void qc?.invalidateQueries({ queryKey: ['pins', id] })
            break
          }
          case 'ack':
            clearDeliveryTimer(parsed.clientId)
            acknowledge(parsed.clientId, parsed.id)
            outstanding.delete(parsed.clientId)
            break
          case 'typing':
            presence.markTyping(id, parsed.userId, parsed.active)
            break
          case 'agent.state':
            presence.setAgentTurns(id, parsed.agentId, parsed.runs)
            break
          case 'presence':
            presence.apply(parsed.users)
            break
          case 'live':
            live.setState(id, parsed.live)
            break
          case 'dm.participants':
            void queryClient()?.invalidateQueries({ queryKey: ['dms'] })
            break
          case 'dm.update':
            void queryClient()?.invalidateQueries({ queryKey: ['dms'] })
            break
          case 'reaction': {
            const qc = queryClient()
            qc?.setQueryData<InfiniteData<Page>>(['messages', id], (old) => {
              if (!old) return old
              return {
                ...old,
                pages: old.pages.map((p) => ({
                  ...p,
                  messages: p.messages.map((m) => {
                    if (m.id !== parsed.messageId) return m
                    return {
                      ...m,
                      reactions: applyReactionChange(m.reactions ?? [], parsed, useSessionStore().user?.id),
                    }
                  }),
                })),
              }
            })
            break
          }
          case 'pin': {
            const qc = queryClient()
            qc?.setQueryData<InfiniteData<Page>>(['messages', id], (old) => {
              if (!old) return old
              return {
                ...old,
                pages: old.pages.map(page => ({
                  ...page,
                  messages: page.messages.map(message => message.id === parsed.messageId
                    ? { ...message, pin: parsed.pin }
                    : message),
                })),
              }
            })
            void qc?.invalidateQueries({ queryKey: ['pins', id] })
            break
          }
          case 'read.ack':
            if (pendingRead && pendingRead.messageId <= parsed.messageId) pendingRead = null
            queryClient()?.setQueryData(['readCursor', parsed.channelId], parsed.messageId)
            applyReadAck(parsed.channelId, parsed.unread)
            break
          case 'error':
            if (parsed.clientId) {
              clearDeliveryTimer(parsed.clientId)
              updateOptimisticMessage(parsed.clientId, message => ({ ...message, deliveryState: 'failed' }))
            }
            break
        }
      })
      socket.addEventListener('close', () => {
        authenticated = false
        if (ws === socket) ws = null
        if (!closed && gen === generation) {
          connection.value = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting'
          const delay = Math.min(12_000, 1500 * 2 ** attempt)
          attempt += 1
          reconnectTimer = setTimeout(() => { void connect(gen) }, delay)
        }
      })
    }
    catch {
      if (!closed && gen === generation) {
        connection.value = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting'
        reconnectTimer = setTimeout(() => { void connect(gen) }, 3000)
      }
    }
    finally {
      connecting = false
      if (!closed && gen !== generation) void connect(generation)
    }
  }

  function send(msg: ClientMsg) {
    if (msg.t === 'message.create') {
      outstanding.set(msg.clientId, msg)
      updateOptimisticMessage(msg.clientId, message => ({ ...message, deliveryState: 'sending' }))
      watchDelivery(msg.clientId)
    }
    if (msg.t === 'read' && (!pendingRead || pendingRead.messageId < msg.messageId)) {
      pendingRead = msg
      queryClient()?.setQueryData(['readCursor', toValue(channelId)], msg.messageId)
      applyReadAck(toValue(channelId), false)
    }
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
      return
    }
    if (msg.t === 'typing' || msg.t === 'auth' || msg.t === 'message.create') return
    if (msg.t === 'read') return
    if (pending.length < 100) pending.push(msg)
  }

  function retry(clientId: string) {
    const message = outstanding.get(clientId)
    if (!message) return
    updateOptimisticMessage(clientId, current => ({ ...current, deliveryState: 'sending' }))
    watchDelivery(clientId)
    if (authenticated && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    else reconnectNow()
  }

  function reconnectNow() {
    if (closed || authenticated || connecting || ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    attempt = 0
    connection.value = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting'
    void connect(generation)
  }

  function disconnect() {
    generation += 1
    closed = true
    authenticated = false
    pending.splice(0)
    pendingRead = null
    outstanding.clear()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    for (const timer of deliveryTimers.values()) clearTimeout(timer)
    deliveryTimers.clear()
    ws?.close()
    ws = null
    connection.value = 'offline'
  }

  watch(() => toValue(channelId), () => {
    generation += 1
    closed = false
    authenticated = false
    attempt = 0
    pending.splice(0)
    pendingRead = null
    outstanding.clear()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    for (const timer of deliveryTimers.values()) clearTimeout(timer)
    deliveryTimers.clear()
    connection.value = 'connecting'
    ws?.close()
    ws = null
    void connect(generation)
  }, { immediate: true })

  const resume = () => reconnectNow()
  onMounted(() => {
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
  })

  onUnmounted(() => {
    window.removeEventListener('focus', resume)
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', resume)
    disconnect()
  })

  return { send, retry, connect, disconnect, connection }
}
