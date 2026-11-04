import { registerPlugin } from '@capacitor/core'

type Server = { origin: string; id: string; name: string }

/** The app's own Swift plugin (`L4SharePlugin.swift`), which fills what the Share Extension reads. */
export const L4Share = registerPlugin<{
  /** Only the bundled Server list may call this. */
  syncServers: (options: { servers: Server[] }) => Promise<void>
  /** This page's Server, when it is bookmarked and has no key yet. */
  serverNeedingKey: () => Promise<{ serverId?: string }>
  /** Saves a key for this page's origin. */
  saveKey: (options: { token: string }) => Promise<void>
  /** Only the bundled Server list may call this. */
  takePendingEditor: () => Promise<{ url?: string }>
  /** The rest are for the bundled marking page only. */
  pendingShare: () => Promise<{ path?: string; name?: string; origin?: string; servers?: { origin: string; name: string }[] }>
  limits: (options: { origin: string }) => Promise<{ json: string }>
  transcribe: (options: { origin: string; at: number; wav: string }) => Promise<{ json: string }>
  sendMarked: (options: { origin: string; contentType: string; body: string }) => Promise<void>
  cancelShare: () => Promise<void>
  /** Leaves this Server for the bundled list. */
  showServers: () => Promise<void>
  /** Whether this page has room for the Server rail. */
  setRail: (options: { visible: boolean }) => Promise<void>
}>('L4Share')
