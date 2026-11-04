import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureRecordingKey, type RecordingKeyStore } from '../../packages/native-shell/recording-key'
import { SPACE_HEADER } from '../../shared/spaces'

function store(serverId: string | null = 'server-1') {
  return { serverNeedingKey: vi.fn(async () => serverId ? { serverId } : null), saveKey: vi.fn(async () => undefined) } satisfies RecordingKeyStore
}
const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('the app getting its device key', () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) })
  })

  it('asks nothing when the page is not a bookmarked Server or already has a key', async () => {
    const fetcher = answer(200)
    expect(await ensureRecordingKey(store(null), 'iPhone', fetcher)).toBe('done')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('spells the Space header the way the Server reads it', () => {
    expect(SPACE_HEADER).toBe('x-l4-space')
  })

  it('saves the key it is given, sent from the Space on screen', async () => {
    localStorage.setItem('llll:active-space', JSON.stringify({ 'server-1': 'space-1' }))
    const keys = store()
    const fetcher = answer(200, { key: { token: 'l4rec_abc' } })
    expect(await ensureRecordingKey(keys, 'iPhone', fetcher)).toBe('done')
    expect(keys.saveKey).toHaveBeenCalledWith('l4rec_abc')
    expect(fetcher).toHaveBeenCalledWith('/api/me/recording-keys', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'x-l4-space': 'space-1' }),
      body: JSON.stringify({ name: 'iPhone' }),
    }))
  })

  it.each([401, 400])('tries again after a %i: signed out, or a Space to choose', async (status) => {
    const keys = store()
    expect(await ensureRecordingKey(keys, 'iPhone', answer(status))).toBe('retry')
    expect(keys.saveKey).not.toHaveBeenCalled()
  })

  it.each([403, 404])('stops after a %i: a Role with no files, or an older Server', async (status) => {
    const keys = store()
    expect(await ensureRecordingKey(keys, 'iPhone', answer(status))).toBe('done')
    expect(keys.saveKey).not.toHaveBeenCalled()
  })
})
