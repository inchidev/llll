interface Window {
  __LLLL_NATIVE_SHOW_SERVERS__?: () => Promise<void>
  /** Whether this page has room for the app's Server rail right now. */
  __LLLL_NATIVE_RAIL__?: (visible: boolean) => Promise<void>
  /** Share a window of this Mac through a Portal: the app asks the person first. Resolves false when they decline. */
  __LLLL_NATIVE_PORTAL__?: {
    share: (link: string) => Promise<boolean>
  }
  __LLLL_NATIVE_NOTIFICATIONS__?: {
    status: () => Promise<'prompt' | 'subscribed' | 'blocked' | 'error'>
    enable: () => Promise<'prompt' | 'subscribed' | 'blocked' | 'error'>
    disable: () => Promise<void>
    setBadge: (count: number) => Promise<void>
    notify: (notification: { id: string; title: string; body: string; badge: number; url: string }) => Promise<void>
  }
}
