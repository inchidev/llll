import { describe, expect, it, vi } from 'vitest'
import {
  activateClientServer,
  clientAppEntryUrl,
  createLiveFetch,
  normalizeServerOrigin,
  resolveServerUrl,
  resolveServerWebSocketUrl,
} from '../../shared/client-router'

describe('client router', () => {
  it('does nothing when the selected server is already active', () => {
    const select = vi.fn()
    const reload = vi.fn()

    activateClientServer({
      origin: 'https://sandbox.llll.gg',
      activeOrigin: 'https://sandbox.llll.gg',
      select,
      reload,
    })

    expect(select).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('selects and reloads when switching servers', () => {
    const select = vi.fn()
    const reload = vi.fn()

    activateClientServer({
      origin: 'https://chat.example.com',
      activeOrigin: 'https://sandbox.llll.gg',
      select,
      reload,
    })

    expect(select).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledWith('https://chat.example.com')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('normalizes a bare server hostname', () => {
    expect(normalizeServerOrigin('sandbox.llll.gg/')).toBe('https://sandbox.llll.gg')
  })

  it('rejects a server URL with a path', () => {
    expect(() => normalizeServerOrigin('https://example.com/chat')).toThrow('without a path')
  })

  it('requires HTTPS away from loopback development', () => {
    expect(() => normalizeServerOrigin('http://example.com')).toThrow('must use HTTPS')
    expect(normalizeServerOrigin('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('routes relative API and media URLs only when a server is selected', () => {
    expect(resolveServerUrl('/api/me', 'https://sandbox.llll.gg')).toBe('https://sandbox.llll.gg/api/me')
    expect(resolveServerUrl('/api/me', null)).toBe('/api/me')
    expect(resolveServerUrl('https://cdn.example.com/file', 'https://sandbox.llll.gg')).toBe('https://cdn.example.com/file')
  })

  it('builds native and web websocket URLs', () => {
    expect(resolveServerWebSocketUrl('/ws/channel/1', 'https://sandbox.llll.gg', 'capacitor://localhost'))
      .toBe('wss://sandbox.llll.gg/ws/channel/1')
    expect(resolveServerWebSocketUrl('/ws/channel/1', null, 'http://localhost:3000'))
      .toBe('ws://localhost:3000/ws/channel/1')
  })

  it('uses the current native fetch implementation at request time', async () => {
    const originalFetch = async () => new Response('original')
    const nativeFetch = async () => new Response('native')
    let currentFetch = originalFetch
    const liveFetch = createLiveFetch(() => currentFetch)

    currentFetch = nativeFetch

    expect(await (await liveFetch('https://sandbox.llll.gg/api/setup/health')).text()).toBe('native')
  })

  it('reloads Chrome extensions through their packaged entry document', () => {
    expect(clientAppEntryUrl('chrome-extension://abcdefghijklmnop/index.html#/channels'))
      .toBe('chrome-extension://abcdefghijklmnop/index.html')
    expect(clientAppEntryUrl('capacitor://localhost/channels')).toBe('/')
  })
})
