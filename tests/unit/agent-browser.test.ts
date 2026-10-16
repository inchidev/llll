import { describe, expect, it, vi } from 'vitest'
import {
  assertPublicHttpUrl,
  captureBrowserScreenshot,
  listBrowserLinks,
  readBrowserMarkdown,
} from '../../workers/agent-browser'

describe('assertPublicHttpUrl', () => {
  it('accepts a public https URL', () => {
    expect(assertPublicHttpUrl('https://developers.cloudflare.com/browser-run/').toString())
      .toBe('https://developers.cloudflare.com/browser-run/')
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'https://user:pass@example.com/',
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://10.0.0.4/internal',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/',
    'http://[::1]/',
  ])('rejects %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow()
  })

  it('rejects the workspace origin', () => {
    expect(() => assertPublicHttpUrl('https://chat.example.com/api/me', ['chat.example.com']))
      .toThrow('workspace origin')
  })
})

describe('Browser Run tools', () => {
  it('reads truncated markdown from a public URL', async () => {
    const markdown = `${'n'.repeat(24_010)}\nend`
    const quickAction = vi.fn(async () => new Response(JSON.stringify({ success: true, result: markdown }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const result = await readBrowserMarkdown(
      { BROWSER: { quickAction }, PUBLIC_ORIGIN: 'https://chat.example.com' },
      'https://example.com/docs',
    )
    expect(quickAction).toHaveBeenCalledWith('markdown', { url: 'https://example.com/docs' })
    expect(result.markdown.endsWith('…truncated')).toBe(true)
    expect(result.markdown.length).toBeLessThan(markdown.length)
  })

  it('lists a bounded set of links', async () => {
    const quickAction = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: Array.from({ length: 80 }, (_, index) => `https://example.com/${index}`),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await listBrowserLinks({ BROWSER: { quickAction } }, 'https://example.com/')
    expect(result.links).toHaveLength(50)
  })

  it('stores a screenshot in R2 without embedding image bytes in the result', async () => {
    const put = vi.fn(async () => undefined)
    const png = new Uint8Array([137, 80, 78, 71])
    const quickAction = vi.fn(async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const result = await captureBrowserScreenshot(
      { BROWSER: { quickAction }, FILES: { put } as unknown as R2Bucket },
      'https://example.com/',
      'agents/agent-1/browser/shot.png',
    )
    expect(put).toHaveBeenCalledWith('agents/agent-1/browser/shot.png', png, {
      httpMetadata: { contentType: 'image/png' },
    })
    expect(result).toEqual({
      url: 'https://example.com/',
      r2Key: 'agents/agent-1/browser/shot.png',
      contentType: 'image/png',
      sizeBytes: 4,
    })
  })

  it('surfaces Browser Run rate limits', async () => {
    const quickAction = vi.fn(async () => new Response('limit', { status: 429 }))
    await expect(readBrowserMarkdown({ BROWSER: { quickAction } }, 'https://example.com/'))
      .rejects.toThrow(/rate limit|Workers Paid/i)
  })
})
