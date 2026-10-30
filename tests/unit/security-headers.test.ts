import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inlineScriptHashes,
  policyForHtml,
  SERVER_PERMISSIONS_POLICY,
  SHELL_PERMISSIONS_POLICY,
  strictTransportSecurity,
  withScriptSources,
} from '../../shared/security-headers'
import { NUXT_ERROR_404_SCRIPT_HASH, serverContentSecurityPolicy } from '../../server/utils/security-policy'
import { applyInlineScriptHashes } from '../../server/utils/csp-script-hashes'

const sha = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`

afterEach(() => vi.unstubAllGlobals())

describe('inline script hashes', () => {
  const config = 'window.__NUXT__={};window.__NUXT__.config={public:{}}'
  const colorMode = '"use strict";(()=>{document.documentElement.className="dark"})()'
  const importMap = '{"imports":{"#entry":"/_nuxt/entry.js"}}'
  const html = `<!DOCTYPE html><html><head><script type="importmap">${importMap}</script>`
    + `<script type="module" src="/_nuxt/entry.js" crossorigin></script><script>${colorMode}</script></head>`
    + `<body><script>${config}</script><script type="application/json" id="__NUXT_DATA__">[{"a":1}]</script>`
    + `<script type="application/ld+json">{"@type":"Thing"}</script><script>${config}</script></body></html>`

  it('hashes executable inline scripts and import maps exactly as browsers do', async () => {
    expect(await inlineScriptHashes(html)).toEqual([sha(importMap), sha(colorMode), sha(config)])
  })

  it('ends a script at any end tag a browser accepts', async () => {
    expect(await inlineScriptHashes('<script>a()</script\t\n bar><script>b()</SCRIPT >')).toEqual([sha('a()'), sha('b()')])
  })

  it('ignores external and JSON data scripts', async () => {
    expect(await inlineScriptHashes('<script src="/a.js"></script><script type="application/json">{}</script>')).toEqual([])
  })

  it('adds the hashes to script-src only', async () => {
    const policy = serverContentSecurityPolicy("'none'")
    const result = await policyForHtml(policy, html)
    const scriptSrc = result.split('; ').find(part => part.startsWith('script-src '))!
    expect(scriptSrc).toBe(`script-src 'self' https://challenges.cloudflare.com https://telegram.org ${NUXT_ERROR_404_SCRIPT_HASH} ${sha(importMap)} ${sha(colorMode)} ${sha(config)}`)
    expect(result).toContain("style-src 'self' 'unsafe-inline'")
    expect(withScriptSources("frame-ancestors 'none'", ["'sha256-x'"])).toBe("frame-ancestors 'none'; script-src 'self' 'sha256-x'")
    expect(withScriptSources(policy, [])).toBe(policy)
  })
})

describe('Server document policy', () => {
  it("allows the installed Nuxt 404 page's runtime script by hash", () => {
    const nuxt = dirname(createRequire(import.meta.url).resolve('nuxt/package.json'))
    const page = readFileSync(join(nuxt, 'dist/app/components/error-404.vue'), 'utf8')
    const script = /innerHTML: `([^`]*)`,\s*tagPosition/.exec(page)?.[1]
    expect(script).toBeTruthy()
    expect(NUXT_ERROR_404_SCRIPT_HASH).toBe(sha(script!))
  })

  it("has no 'unsafe-inline' scripts and keeps embedding and Live working", () => {
    const policy = serverContentSecurityPolicy("'self' https://llll.gg")
    const scriptSrc = policy.split('; ').find(part => part.startsWith('script-src '))!
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(scriptSrc).not.toContain('unsafe-eval')
    expect(policy).toContain("frame-ancestors 'self' https://llll.gg")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("media-src 'self' blob:")
    expect(SERVER_PERMISSIONS_POLICY).toContain('camera=(self)')
    expect(SERVER_PERMISSIONS_POLICY).toContain('microphone=(self)')
    expect(SERVER_PERMISSIONS_POLICY).toContain('display-capture=(self)')
    expect(SERVER_PERMISSIONS_POLICY).toContain('geolocation=()')
  })

  it('never restricts the features the Shell delegates to embedded Clients', () => {
    for (const feature of ['camera', 'microphone', 'display-capture', 'fullscreen', 'clipboard-write']) {
      expect(SHELL_PERMISSIONS_POLICY).not.toContain(feature)
    }
    expect(SHELL_PERMISSIONS_POLICY).toContain('payment=()')
  })
})

describe('Strict-Transport-Security', () => {
  it('is sent for HTTPS only', () => {
    expect(strictTransportSecurity(new URL('https://chat.example.com/'), null, false)).toBe('max-age=31536000')
    expect(strictTransportSecurity(new URL('https://llll.gg/'), null, true)).toBe('max-age=31536000; includeSubDomains')
    expect(strictTransportSecurity(new URL('http://chat.example.com/'), null, false)).toBeNull()
  })

  it('honours a TLS-terminating proxy but never pins local development hosts', () => {
    expect(strictTransportSecurity(new URL('http://chat.example.com/'), 'https', false)).toBe('max-age=31536000')
    expect(strictTransportSecurity(new URL('http://chat.example.com/'), 'http', false)).toBeNull()
    for (const url of ['https://localhost:3000/', 'https://127.0.0.1/', 'https://[::1]/', 'https://app.localhost/']) {
      expect(strictTransportSecurity(new URL(url), 'https', true)).toBeNull()
    }
  })
})

describe('CSP hash plugin', () => {
  function stub(headers: Record<string, string>) {
    vi.stubGlobal('getResponseHeader', (_event: unknown, name: string) => headers[name.toLowerCase()])
    vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: string) => { headers[name.toLowerCase()] = value })
    return headers
  }

  it('appends hashes for the exact HTML body that is sent', async () => {
    const headers = stub({ 'content-security-policy': serverContentSecurityPolicy("'none'"), 'content-type': 'text/html;charset=utf-8' })
    await applyInlineScriptHashes({} as never, '<html><script>history.replaceState(null,"","/")</script></html>')
    expect(headers['content-security-policy']).toContain(sha('history.replaceState(null,"","/")'))
  })

  it('treats untyped string bodies as HTML, leaves other types alone', async () => {
    const untyped = stub({ 'content-security-policy': "script-src 'self'" })
    await applyInlineScriptHashes({} as never, '<script>a()</script>')
    expect(untyped['content-security-policy']).toBe(`script-src 'self' ${sha('a()')}`)
    const json = stub({ 'content-security-policy': "script-src 'self'", 'content-type': 'application/json' })
    await applyInlineScriptHashes({} as never, '{"html":"<script>a()</script>"}')
    expect(json['content-security-policy']).toBe("script-src 'self'")
  })
})
