import type { CreatedRecordingKeyDTO } from '../../shared/task-recordings'

// A device key lets the app's share sheet send recordings with no Shortcut and nothing to paste.
// It runs inside the Server's own Client, so the request carries that Client's session and needs
// no Server changes. The key can only send recordings, and it shows under Your phone, where it can
// be turned off.
export type RecordingKeyStore = {
  /** This page's Server, when it is bookmarked on this device and has no key yet. */
  serverNeedingKey: () => Promise<{ serverId: string } | null>
  saveKey: (token: string) => Promise<void>
}

/** `done` stops asking on this page: the key is saved, or this Server or Role can't make one. */
export async function ensureRecordingKey(store: RecordingKeyStore, name: string, fetcher: typeof fetch = fetch): Promise<'done' | 'retry'> {
  const server = await store.serverNeedingKey()
  if (!server) return 'done'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const spaceId = activeSpaceId(server.serverId)
  // Spelled out: importing it would bring zod into a script injected into every page.
  if (spaceId) headers['x-l4-space'] = spaceId
  const response = await fetcher('/api/me/recording-keys', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ name }) })
  // Signed out, or a Space still to choose: both can change without a page load.
  if (response.status === 401 || response.status === 400) return 'retry'
  if (!response.ok) return 'done'
  const { key } = await response.json() as { key: CreatedRecordingKeyDTO }
  await store.saveKey(key.token)
  return 'done'
}

function activeSpaceId(serverId: string): string | null {
  try {
    const value = (JSON.parse(localStorage.getItem('llll:active-space') || '{}') as Record<string, unknown>)[serverId]
    return typeof value === 'string' ? value : null
  }
  catch {
    return null
  }
}

/** Asks on load, when the app comes back, and while the page stays open, so signing in is enough. */
export function keepRecordingKey(store: RecordingKeyStore, name: string) {
  let asking = false
  const stop = () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', ask)
  }
  async function ask() {
    if (asking || document.visibilityState !== 'visible') return
    asking = true
    try {
      if (await ensureRecordingKey(store, name) === 'done') stop()
    }
    catch { /* Offline: the next try asks again. */ }
    finally {
      asking = false
    }
  }
  const timer = setInterval(() => { void ask() }, 30_000)
  document.addEventListener('visibilitychange', ask)
  void ask()
}
