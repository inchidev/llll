import { afterEach, describe, expect, it, vi } from 'vitest'
import { patchWorkerBindings } from '../../../packages/admin-core/src/worker-settings'

afterEach(() => vi.unstubAllGlobals())

describe('Worker settings transport', () => {
  it('sends bindings as the required multipart settings part', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/llll-inchi/settings')
      expect(init?.method).toBe('PATCH')
      expect(new Headers(init?.headers).get('Content-Type')).toBeNull()
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('settings')).toBe(JSON.stringify({
        bindings: [{ type: 'plain_text', name: 'PUBLIC_ORIGIN', text: 'https://inchi.llll.gg' }],
      }))
      return Response.json({ success: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)

    await patchWorkerBindings('access-token', 'account-id', 'llll-inchi', [
      { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: 'https://inchi.llll.gg' },
    ])

    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
