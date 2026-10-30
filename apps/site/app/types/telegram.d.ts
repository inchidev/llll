export {}
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string
        ready?: () => void
        expand?: () => void
        isVersionAtLeast?: (version: string) => boolean
        platform?: string
        /** Bot API 8.0+. */
        requestFullscreen?: () => void
        /** Bot API 7.7+: a vertical swipe no longer minimizes or closes the app. */
        disableVerticalSwipes?: () => void
        setHeaderColor?: (color: string) => void
        setBackgroundColor?: (color: string) => void
        /** Bot API 7.10+. */
        setBottomBarColor?: (color: string) => void
        /** Bot API 8.0+: the device's insets, and Telegram's own controls over a full-screen app. */
        safeAreaInset?: { top?: number; bottom?: number }
        contentSafeAreaInset?: { top?: number; bottom?: number }
        onEvent?: (name: string, callback: () => void) => void
        /** Bot API 6.9+: asks the person to let the bot message them. */
        requestWriteAccess?: (callback?: (granted: boolean) => void) => void
        /** Opens a link in the device's own browser, outside Telegram. */
        openLink?: (url: string) => void
      }
    }
  }
}
