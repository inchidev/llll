import { describe, it, expect } from 'vitest'
import { embedCommand, embedEvent, embedOrigins, safeEmbedPath } from '../../shared/embed'

describe('installation embedding boundary', () => {
  it('accepts navigation and refuses executable, external and API destinations', () => {
    expect(safeEmbedPath('/channels/one?thread=two')).toBe(true)
    for (const path of ['//evil.example', '/\\evil.example', '/api/auth/sign-out', '/ws/workspace/main', '/connections', '/channels/\nfoo', 'javascript:alert(1)']) expect(safeEmbedPath(path), path).toBe(false)
    expect(embedCommand.safeParse({ type: 'open', serverId: 'alpha', path: '/' }).success).toBe(false)
  })
  it('only exposes bounded shell metadata, with opaque global server IDs', () => {
    const id = crypto.randomUUID()
    expect(embedEvent.parse({ type: 'servers', servers: [{ id, name: 'Community', unread: 3, assetToken: 'must-not-cross-frame' }] })).toEqual({ type: 'servers', servers: [{ id, name: 'Community', unread: 3 }] })
    expect(embedEvent.safeParse({ type: 'servers', servers: [{ id, name: 'Community', unread: -1 }] }).success).toBe(false)
    expect(embedOrigins('https://games.example,*,https://evil.example/path')).toEqual(['https://llll.gg', 'https://games.example'])
  })
})
