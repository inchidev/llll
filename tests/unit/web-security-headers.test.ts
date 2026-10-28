import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withSiteSecurityHeaders } from '../../apps/site/src/index'

const sha = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`

describe('official site security headers', () => {
  it('allows each document its own inline scripts by hash and keeps the body intact', async () => {
    const html = '<!doctype html><script>window.__NUXT__={}</script><script type="application/json">[1]</script><div id="__nuxt"></div>'
    const response = await withSiteSecurityHeaders(
      new Request('https://llll.gg/create'),
      new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    )
    const policy = response.headers.get('Content-Security-Policy')!
    expect(policy).toContain(`script-src 'self' https://telegram.org ${sha('window.__NUXT__={}')}`)
    expect(policy).not.toContain('unsafe-inline')
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(await response.text()).toBe(html)
  })

  it('sends HSTS with subdomains on HTTPS and a Permissions-Policy that still delegates Live to embedded Servers', async () => {
    const response = await withSiteSecurityHeaders(new Request('https://llll.gg/api/health'), Response.json({ ok: true }))
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    const permissions = response.headers.get('Permissions-Policy')!
    expect(permissions).toContain('geolocation=()')
    expect(permissions).not.toContain('camera')
    expect(permissions).not.toContain('microphone')
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' https://telegram.org")
  })

  it('omits HSTS on local development', async () => {
    const response = await withSiteSecurityHeaders(new Request('http://localhost:8787/'), new Response('ok'))
    expect(response.headers.get('Strict-Transport-Security')).toBeNull()
  })
})
