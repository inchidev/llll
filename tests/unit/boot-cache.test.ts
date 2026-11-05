import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { BootSnapshot } from '../../app/utils/boot-cache'
import { accountStorage, cachedQuery, clearBootCache, queriesStorageKey, readBootSnapshot, saveBootSnapshot } from '../../app/utils/boot-cache'
import type { useSessionStore as SessionStoreFactory } from '../../app/stores/session'

const stored = new Map<string, string>()
const storage = new Proxy({
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
}, { ownKeys: () => [...stored.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) })

const snapshot = { user: { id: 'owner' }, health: { ready: true } } as unknown as BootSnapshot
let useSessionStore: typeof SessionStoreFactory

beforeAll(async () => {
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('useServers', () => ({ tokens: ref({}) }))
  ;({ useSessionStore } = await import('../../app/stores/session'))
})

beforeEach(() => {
  stored.clear()
  setActivePinia(createPinia())
})

function serverAnswering(me: () => unknown) {
  return vi.fn(async (path: string) => path === '/api/me' ? me() : { ready: true })
}

describe('what a reload may show before the Server answers', () => {
  it('keeps mail, tokens and settings off the device', () => {
    for (const key of ['messages', 'channels', 'members', 'server']) expect(cachedQuery([key, 'id'])).toBe(true)
    for (const key of ['mail-threads', 'mail-thread', 'mailboxes', 'mcp-tokens', 'recording-keys', 'lizard-compute-connection']) expect(cachedQuery([key])).toBe(false)
  })

  it('removes this Account from the device, and treats a damaged value as nothing', () => {
    saveBootSnapshot(snapshot)
    stored.set(queriesStorageKey('owner'), '{}')
    stored.set('llll.discovery', '{}')
    expect(readBootSnapshot()?.user.id).toBe('owner')
    clearBootCache()
    expect(readBootSnapshot()).toBeNull()
    expect(stored.has(queriesStorageKey('owner'))).toBe(false)
    expect(stored.has('llll.discovery')).toBe(true)
    stored.set('llll.boot', 'not json')
    expect(readBootSnapshot()).toBeNull()
  })
})

describe('a throttled write after sign-out', () => {
  it('leaves nothing on the device', () => {
    let signedIn = true
    const accountData = accountStorage(() => signedIn)
    accountData.setItem(queriesStorageKey('owner'), 'first')
    expect(stored.get(queriesStorageKey('owner'))).toBe('first')
    signedIn = false
    clearBootCache()
    accountData.setItem(queriesStorageKey('owner'), 'late')
    expect(stored.has(queriesStorageKey('owner'))).toBe(false)
  })
})

describe('checking the shown session with the Server', () => {
  it('signs out and clears the device only when the Server says the session ended', async () => {
    const session = useSessionStore()
    saveBootSnapshot(snapshot)
    session.restore(snapshot)
    expect(session.ready).toBe(true)
    await expect(session.revalidate(serverAnswering(() => { throw Object.assign(new Error('Login required'), { status: 401 }) }))).resolves.toBe('ended')
    expect(session.user).toBeNull()
    expect(readBootSnapshot()).toBeNull()
  })

  it('keeps the screen through a network failure', async () => {
    const session = useSessionStore()
    saveBootSnapshot(snapshot)
    session.restore(snapshot)
    await expect(session.revalidate(serverAnswering(() => { throw new TypeError('Failed to fetch') }))).resolves.toBe('current')
    expect(session.user?.id).toBe('owner')
    expect(readBootSnapshot()).not.toBeNull()
  })

  it('never leaves another Account\'s cache in place', async () => {
    const session = useSessionStore()
    saveBootSnapshot(snapshot)
    session.restore(snapshot)
    await expect(session.revalidate(serverAnswering(() => ({ user: { id: 'someone-else' } })))).resolves.toBe('changed')
    expect(readBootSnapshot()).toBeNull()
  })

  it('remembers a current session, and forgets it on sign-out', async () => {
    const session = useSessionStore()
    await session.refresh(serverAnswering(() => ({ user: { id: 'owner' } })))
    expect(readBootSnapshot()?.user.id).toBe('owner')
    await session.logout(vi.fn(async () => undefined))
    expect(readBootSnapshot()).toBeNull()
  })
})
