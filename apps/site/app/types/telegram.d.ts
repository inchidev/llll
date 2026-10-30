export {}
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string
        ready?: () => void
        expand?: () => void
        isVersionAtLeast?: (version: string) => boolean
        /** Bot API 6.9+: asks the person to let the bot message them. */
        requestWriteAccess?: (callback?: (granted: boolean) => void) => void
        /** Opens a link in the device's own browser, outside Telegram. */
        openLink?: (url: string) => void
      }
    }
  }
}
