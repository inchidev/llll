import { describe, expect, it } from 'vitest'
import { resolveAuthBaseURL } from '../../server/utils/better-auth'

describe('resolveAuthBaseURL', () => {
  it('uses the request origin when no public origin is configured', () => {
    expect(resolveAuthBaseURL(undefined, 'http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('uses the configured public origin behind a reverse proxy', () => {
    expect(resolveAuthBaseURL('https://chat.example.com/', 'http://llll:3000')).toBe('https://chat.example.com')
  })

  it.each([
    'chat.example.com',
    'ftp://chat.example.com',
    'https://user:secret@chat.example.com',
    'https://chat.example.com/path',
    'https://chat.example.com?query=yes',
    'https://chat.example.com/#fragment',
  ])('rejects invalid public origin %s', (origin) => {
    expect(() => resolveAuthBaseURL(origin, 'http://localhost:3000')).toThrow('PUBLIC_ORIGIN')
  })
})
