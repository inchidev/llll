type L4NotificationStatus = 'prompt' | 'subscribed' | 'blocked' | 'error'

interface Window {
  __LLLL_EXTENSION__?: {
    requestServerAccess: (origin: string) => Promise<boolean>
  }
  __LLLL_NATIVE_NOTIFICATIONS__?: {
    status: () => Promise<L4NotificationStatus>
    enable: () => Promise<L4NotificationStatus>
    disable: () => Promise<void>
    setBadge: (count: number) => Promise<void>
    notify: (notification: { id: string; title: string; body: string; badge: number; url: string }) => Promise<void>
  }
}
