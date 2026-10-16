import type { QueryClient } from '@tanstack/vue-query'
import { ref } from 'vue'
import type { WorkspaceClientMsg, WorkspaceServerMsg } from '~~/shared/types'
import type { WorkspaceRealtimeEvent } from '~~/shared/workspace-realtime'
import { applyWorkspaceRealtimeEvent } from '../utils/workspace-realtime'
import type { InjectionKey, Ref } from 'vue'
import type { RealtimeConnection } from './useChannelSocket'

/** The app shell owns the one workspace connection; views read its state through this key. */
export const workspaceConnectionKey: InjectionKey<Readonly<Ref<RealtimeConnection>>> = Symbol('workspace-connection')

export function useWorkspaceSocket(workspaceId: MaybeRefOrGetter<string>) {
  const { api, socketUrl } = useApi()
  const presence = usePresenceStore()
  const prefs = usePrefsStore()
  const nuxt = useNuxtApp()
  const attention = useAttention()
  const connection = ref<RealtimeConnection>('connecting')
  let ws: WebSocket | null = null
  let closed = false
  let connecting = false
  let attempt = 0
  let generation = 0
  let lastActivity = 0
  let authenticated = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function queryClient(): QueryClient | undefined {
    return nuxt.$queryClient as QueryClient | undefined
  }

  function sendActivity(force = false) {
    if (!import.meta.client || (!force && document.hidden) || (!force && Date.now() - lastActivity < 10_000)) return
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'activity', visible: prefs.showOnline } satisfies WorkspaceClientMsg))
      lastActivity = Date.now()
    }
  }

  async function connect(gen = generation) {
    const id = toValue(workspaceId)
    if (!id || !import.meta.client || connecting || closed) return
    connecting = true
    connection.value = attempt ? 'reconnecting' : 'connecting'
    try {
      const { token } = await api<{ token: string }>('/api/auth/ws-token', { method: 'POST' })
      if (closed || gen !== generation) return
      const socket = new WebSocket(socketUrl(`/ws/workspace/${id}`))
      ws = socket
      socket.addEventListener('open', () => {
        if (gen !== generation) return socket.close()
        attempt = 0
        socket.send(JSON.stringify({ t: 'auth', token, visible: prefs.showOnline } satisfies WorkspaceClientMsg))
      })
      socket.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string' || ev.data === 'pong') return
        let parsed: WorkspaceServerMsg | WorkspaceRealtimeEvent
        try { parsed = JSON.parse(ev.data) as WorkspaceServerMsg | WorkspaceRealtimeEvent }
        catch { return }
        if (parsed.t === 'hello') {
          authenticated = true
          connection.value = 'connected'
        }
        else if (parsed.t === 'presence') presence.apply(parsed.users)
        else if (parsed.t === 'channel.activity' || parsed.t === 'channel.read' || parsed.t === 'tasks.changed' || parsed.t === 'mail.changed' || parsed.t === 'members.changed' || parsed.t === 'live.changed') {
          const qc = queryClient()
          if (qc) applyWorkspaceRealtimeEvent(qc, parsed)
          if (parsed.t === 'live.changed') {
            const live = useLiveStore()
            const toast = useToast()
            live.receiveLive(parsed)
            // Announce a room once, when it starts; joins and leaves only update the sidebar.
            const announcement = parsed.notification
            if (announcement && parsed.live.active && !parsed.ring && live.viewingChannelId !== parsed.channelId) {
              toast.add({
                title: announcement.title,
                description: announcement.body,
                icon: 'i-ph-waveform',
                actions: [{ label: 'Open', onClick: () => navigateTo(announcement.url) }],
              })
            }
          }
          else if (parsed.t === 'channel.activity') {
            attention.notifyActivity(parsed)
          }
          else if (parsed.t === 'channel.read') attention.sync()
        }
      })
      socket.addEventListener('close', () => {
        authenticated = false
        if (ws === socket) ws = null
        if (!closed && gen === generation) {
          connection.value = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting'
          const delay = Math.min(12_000, 2000 * 2 ** attempt)
          attempt += 1
          reconnectTimer = setTimeout(() => { void connect(gen) }, delay)
        }
      })
    }
    catch {
      if (!closed && gen === generation) {
        connection.value = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting'
        reconnectTimer = setTimeout(() => { void connect(gen) }, 4000)
      }
    }
    finally {
      connecting = false
      if (!closed && gen !== generation) void connect(generation)
    }
  }

  function disconnect() {
    generation += 1
    closed = true
    authenticated = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    ws?.close()
    ws = null
    connection.value = 'offline'
  }

  function reconnectNow() {
    if (closed || authenticated || connecting || ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    attempt = 0
    void connect(generation)
  }

  watch(() => toValue(workspaceId), () => {
    generation += 1
    closed = false
    authenticated = false
    attempt = 0
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    connection.value = 'connecting'
    ws?.close()
    ws = null
    void connect(generation)
  }, { immediate: true })

  const activity = () => sendActivity()
  const resume = () => {
    reconnectNow()
    sendActivity(true)
  }
  onMounted(() => {
    window.addEventListener('pointerdown', activity, { passive: true })
    window.addEventListener('keydown', activity)
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
  })

  onUnmounted(() => {
    window.removeEventListener('pointerdown', activity)
    window.removeEventListener('keydown', activity)
    window.removeEventListener('focus', resume)
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', resume)
    disconnect()
  })

  watch(() => prefs.showOnline, () => sendActivity(true))

  return { connection, connect, disconnect }
}
