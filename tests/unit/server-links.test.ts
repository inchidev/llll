// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readServerIdentity, takeLinkBack } from '../../app/composables/useServerLinks'

const ID = '00000000-0000-4000-8000-000000000001'
const identity = (over: Record<string, unknown> = {}) => ({ product: 'llll', kind: 'server', apiVersion: 2, id: ID, name: 'Acme', origin: 'https://acme.example', ...over })
const answering = (body: unknown, ok = true) => vi.fn(async () => Response.json(body, { status: ok ? 200 : 500 })) as unknown as typeof fetch

describe('a Server identity', () => {
  it('asks without credentials and takes the Server at its word only for its own address', async () => {
    const fetcher = answering(identity())
    expect(await readServerIdentity('acme.example', fetcher)).toEqual({ origin: 'https://acme.example', id: ID, name: 'Acme' })
    expect(vi.mocked(fetcher).mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    await expect(readServerIdentity('https://evil.example', answering(identity()))).rejects.toThrow('not a compatible')
    expect(await readServerIdentity('https://alias.example', answering(identity({ aliases: ['https://alias.example'] })))).toMatchObject({ origin: 'https://alias.example' })
  })

  it('refuses what is not a Server', async () => {
    await expect(readServerIdentity('https://acme.example', answering(identity({ product: 'other' })))).rejects.toThrow('not a compatible')
    await expect(readServerIdentity('https://acme.example', answering(identity({ id: 'nope' })))).rejects.toThrow('not a compatible')
    await expect(readServerIdentity('https://acme.example', answering({}, false))).rejects.toThrow('Could not reach')
    await expect(readServerIdentity('http://acme.example', answering(identity()))).rejects.toThrow('HTTPS')
  })
})

describe('a link back', () => {
  beforeEach(() => { history.replaceState(null, '', '/') })
  const at = (hash: string) => { history.replaceState(null, '', `/channels/one${hash}`) }

  it('is read once and leaves the rest of the address alone', () => {
    at('#from=https%3A%2F%2Fother.example&panel=x')
    expect(takeLinkBack()).toBe('https://other.example')
    expect(location.pathname + location.hash).toBe('/channels/one#panel=x')
    expect(takeLinkBack()).toBeNull()
  })

  it('ignores an address that is not a Server origin, and this Server itself', () => {
    at('#from=javascript%3Aalert(1)')
    expect(takeLinkBack()).toBeNull()
    expect(location.hash).toBe('')
    at('#from=http%3A%2F%2Fother.example')
    expect(takeLinkBack()).toBeNull()
    at(`#from=${encodeURIComponent(location.origin)}`)
    expect(takeLinkBack()).toBeNull()
  })
})
