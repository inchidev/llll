import type { QueryClient } from '@tanstack/vue-query'
import type { ChannelDTO } from '~~/shared/types'
import type { WorkspaceChannelActivityEvent } from '~~/shared/workspace-realtime'
import { unreadChannelCount } from '../utils/attention'

type ChannelList = { channels: ChannelDTO[] }
type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

let originalTitle = ''
const delivered = new Set<string>()

export function useAttention() {
  const nuxt = useNuxtApp()
  const prefs = usePrefsStore()

  function queryClient(): QueryClient | undefined {
    return nuxt.$queryClient as QueryClient | undefined
  }

  function sync(): number {
    if (!originalTitle) originalTitle = document.title.replace(/^\(\d+\)\s+/, '') || 'L4'
    const qc = queryClient()
    if (!qc) return 0
    const lists = [
      ...qc.getQueriesData<ChannelList>({ queryKey: ['channels'] }).map(([, data]) => data),
      ...qc.getQueriesData<ChannelList>({ queryKey: ['dms'] }).map(([, data]) => data),
    ]
    const count = unreadChannelCount(lists)
    document.title = count ? `(${count}) ${originalTitle}` : originalTitle
    const badges = navigator as BadgeNavigator
    const update = count ? badges.setAppBadge?.(count) : badges.clearAppBadge?.()
    void update?.catch(() => undefined)
    void window.__LLLL_NATIVE_NOTIFICATIONS__?.setBadge(count).catch(() => undefined)
    return count
  }

  function sound() {
    if (!prefs.messageSounds) return
    try {
      const context = new AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(660, context.currentTime)
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.07, context.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.17)
      oscillator.addEventListener('ended', () => { void context.close() })
    }
    catch {
      // Autoplay policy can reject audio before the first user gesture.
    }
  }

  function notifyActivity(event: WorkspaceChannelActivityEvent) {
    const count = Math.max(1, sync())
    if (delivered.has(event.messageId)) return
    delivered.add(event.messageId)
    if (delivered.size > 200) delivered.delete(delivered.values().next().value!)
    if (!document.hidden && document.hasFocus()) {
      sound()
      return
    }
    const bridge = window.__LLLL_NATIVE_NOTIFICATIONS__
    if (!bridge) return
    void bridge.notify({
      id: event.messageId,
      title: event.notification.title,
      body: event.notification.body,
      badge: count,
      url: event.notification.url,
    }).catch(() => undefined)
  }

  return { sync, notifyActivity }
}
