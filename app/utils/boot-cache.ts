import type { ServerDiscovery } from '~~/shared/server'
import type { SessionUser, SetupHealth } from '~~/shared/types'

export type BootSnapshot = { user: SessionUser, health: SetupHealth }

const BOOT_KEY = 'llll.boot', DISCOVERY_KEY = 'llll.discovery', QUERIES_PREFIX = 'llll.queries:'

/**
 * What a reload may show before the Server answers. Mail, tokens, credentials and settings stay out,
 * so they are never left on this device, and always come from the Server.
 */
const CACHED_QUERIES = new Set(['server', 'spaces', 'channels', 'channel', 'dms', 'members', 'roles', 'boards', 'projects', 'agents', 'inbox', 'threads', 'messages'])

export const queriesStorageKey = (userId: string) => QUERIES_PREFIX + userId
export const cachedQuery = (key: readonly unknown[]) => typeof key[0] === 'string' && CACHED_QUERIES.has(key[0])

function read<T>(key: string): T | null {
  try {
    const stored = localStorage.getItem(key)
    return stored ? JSON.parse(stored) as T : null
  }
  catch { return null } // Private windows and damaged values start from the Server.
}

function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) }
  catch { /* Without storage the next load waits for the Server. */ }
}

export const readBootSnapshot = () => {
  const snapshot = read<BootSnapshot>(BOOT_KEY)
  return snapshot?.user?.id && snapshot.health ? snapshot : null
}
export const saveBootSnapshot = (snapshot: BootSnapshot) => write(BOOT_KEY, snapshot)
export const readDiscovery = () => read<ServerDiscovery>(DISCOVERY_KEY)
export const saveDiscovery = (discovery: ServerDiscovery) => write(DISCOVERY_KEY, discovery)

/**
 * Storage for one Account's queries. Writes are throttled, so one can fire after sign-out:
 * it must find nothing to write to.
 */
export function accountStorage(current: () => boolean) {
  return {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => { if (current()) localStorage.setItem(key, value) },
    removeItem: (key: string) => localStorage.removeItem(key),
  }
}

/** Signing out, or a session that ended, leaves nothing from this Account on the device. */
export function clearBootCache() {
  try {
    localStorage.removeItem(BOOT_KEY)
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(QUERIES_PREFIX)) localStorage.removeItem(key)
    }
  }
  catch { /* No storage means nothing was kept. */ }
}
