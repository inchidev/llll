interface Window {
  __LLLL_NATIVE_NOTIFICATIONS__?: {
    status: () => Promise<'prompt' | 'subscribed' | 'blocked' | 'error'>
    enable: () => Promise<'prompt' | 'subscribed' | 'blocked' | 'error'>
    disable: () => Promise<void>
    setBadge: (count: number) => Promise<void>
    notify: (notification: { id: string; title: string; body: string; badge: number; url: string }) => Promise<void>
  }
}
