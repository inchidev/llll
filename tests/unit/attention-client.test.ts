import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useAttention as AttentionFactory } from '../../app/composables/useAttention.client'

const embeddedUnread = { value: 0 }
const setBadge = vi.fn(async () => undefined)
const notify = vi.fn(async () => undefined)
const start = vi.fn()
const stop = vi.fn()
const close = vi.fn(async () => undefined)
const addEventListener = vi.fn()
const connect = vi.fn()
const setValueAtTime = vi.fn()
const exponentialRampToValueAtTime = vi.fn()
const queryClient = {
  getQueriesData: vi.fn(({ queryKey }: { queryKey: string[] }) => queryKey[0] === 'channels'
    ? [[['channels', 'main'], { channels: [{ id: 'general', unread: true }] }]]
    : []),
}
let useAttention: typeof AttentionFactory

beforeAll(async () => {
  vi.stubGlobal('document', { title: 'L4', hidden: true, hasFocus: () => false })
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('AudioContext', class {
    currentTime = 0
    destination = {}
    createOscillator() {
      return { type: 'sine', frequency: { setValueAtTime }, connect, start, stop, addEventListener }
    }
    createGain() {
      return { gain: { setValueAtTime, exponentialRampToValueAtTime }, connect }
    }
    close = close
  })
  vi.stubGlobal('window', {
    __LLLL_NATIVE_NOTIFICATIONS__: { setBadge, notify },
  })
  vi.stubGlobal('useNuxtApp', () => ({ $queryClient: queryClient }))
  vi.stubGlobal('useState', () => embeddedUnread)
  vi.stubGlobal('usePrefsStore', () => ({ messageSounds: true }))
  ;({ useAttention } = await import('../../app/composables/useAttention.client'))
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(document, { hidden: true, hasFocus: () => false })
})

describe('native attention bridge', () => {
  it('reconciles the native badge with unread conversations', () => {
    expect(useAttention().sync()).toBe(1)
    expect(setBadge).toHaveBeenCalledWith(1)
    expect(embeddedUnread.value).toBe(1)
  })

  it('passes message context and a Channel route to the native notification', () => {
    useAttention().notifyActivity({
      t: 'channel.activity',
      sourceChannelId: 'general',
      rootChannelId: 'general',
      messageId: 'message-native-route',
      notification: {
        title: 'Alice in #general',
        body: 'hello',
        url: '/channels/general',
      },
    })

    expect(notify).toHaveBeenCalledWith({
      id: 'message-native-route',
      title: 'Alice in #general',
      body: 'hello',
      badge: 1,
      url: '/channels/general',
    })
  })

  it('plays one in-app sound instead of an OS notification in the foreground', () => {
    Object.assign(document, { hidden: false, hasFocus: () => true })

    useAttention().notifyActivity({
      t: 'channel.activity',
      sourceChannelId: 'general',
      rootChannelId: 'general',
      messageId: 'message-foreground-sound',
      notification: {
        title: 'Alice in #general',
        body: 'hello',
        url: '/channels/general',
      },
    })

    expect(start).toHaveBeenCalledOnce()
    expect(notify).not.toHaveBeenCalled()
  })
})
