type L4NativeNotificationStatus = 'prompt' | 'subscribed' | 'blocked' | 'error'

interface Window {
  __LLLL_OPEN_AUTH__?: (url: string) => Promise<void>
  __LLLL_NATIVE_SHOW_SERVERS__?: () => Promise<void>
  /** Whether this page has room for the app's Server rail right now. */
  __LLLL_NATIVE_RAIL__?: (visible: boolean) => Promise<void>
  __LLLL_NATIVE_NOTIFICATIONS__?: {
    status: () => Promise<L4NativeNotificationStatus>
    enable: () => Promise<L4NativeNotificationStatus>
    disable: () => Promise<void>
    setBadge: (count: number) => Promise<void>
    notify: (notification: { id: string; title: string; body: string; badge: number; url: string }) => Promise<void>
  }
}
