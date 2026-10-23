import { describe, expect, it } from 'vitest'
import { fileResponseHeaders } from '../../shared/file-response'

describe('file response isolation', () => {
  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/xml', 'application/octet-stream'])('downloads %s with a sandbox and no sniffing, including legacy rows', (type) => {
    const headers = fileResponseHeaders(type, 'file.html')
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(headers['Content-Disposition']).toMatch(/^attachment;/u)
    expect(headers['Content-Security-Policy']).toContain('sandbox')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })
  it.each(['image/png', 'application/pdf', 'text/plain', 'audio/ogg'])('preserves safe %s previews', (type) => {
    expect(fileResponseHeaders(type, 'file')['Content-Disposition']).toMatch(/^inline;/u)
  })
  it('keeps Unicode filenames without permitting header injection', () => {
    const headers = fileResponseHeaders('text/plain', 'счёт\r\n".txt')
    expect(headers['Content-Disposition']).not.toMatch(/[\r\n]/u)
    expect(headers['Content-Disposition']).toContain("filename*=UTF-8''%D1%81")
    expect(() => new Headers(headers)).not.toThrow()
  })
})
