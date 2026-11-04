import { describe, expect, it, vi } from 'vitest'
import {
  assertPublicDestination,
  assertPublicHttpUrl,
  captureBrowserScreenshot,
  listBrowserLinks,
  readBrowserMarkdown,
} from '../../workers/agent-browser'
import { chromiumQuickAction, type CdpClient } from '../../workers/browser-cdp'

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

  it.each([
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://localhost./',
    'http://LOCALHOST../',
    'http://app.localhost./',
    'http://printer.local./',
    'http://nas.home.arpa/',
    'http://llll:8080/',
    'http://rustfs:9000/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://127.0.0.1./',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://100.127.255.254/',
    'http://198.18.0.1/',
    'http://198.19.255.255/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a00:1]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[::127.0.0.1]/',
    'http://[::a00:1]/',
    'http://[64:ff9b::127.0.0.1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[64:ff9b:1::a00:1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://[fec0::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[ff02::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2001::1]/',
    'http://[2001:db8::1]/',
  ])('rejects non-public address %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow('not a public website')
  })

  it.each([
    'https://example.com/',
    'https://1.1.1.1/',
    'https://8.8.8.8/',
    'https://100.128.0.1/',
    'https://[2606:4700::1111]/',
    'https://[2001:4860:4860::8888]/',
    'https://example.com./',
  ])('accepts %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).not.toThrow()
  })

  it('rejects the server origin', () => {
    expect(() => assertPublicHttpUrl('https://chat.example.com/api/me', ['chat.example.com']))
      .toThrow('server origin')
    expect(() => assertPublicHttpUrl('https://chat.example.com./api/me', ['chat.example.com']))
      .toThrow('server origin')
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

describe('Chromium final URL check', () => {
  function clientEndingAt(finalUrl: string): CdpClient {
    return {
      async send(method) {
        if (method === 'Target.createTarget') return { targetId: 'target-1' }
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' }
        if (method === 'Target.getTargetInfo') return { targetInfo: { url: finalUrl } }
        if (method === 'Runtime.evaluate') return { result: { value: 'secret' } }
        return {}
      },
      async waitFor() {},
      async close() {},
    }
  }

  it('refuses content when navigation redirected to a private address', async () => {
    await expect(chromiumQuickAction(clientEndingAt('http://rustfs:9000/'), 'markdown', 'https://example.com/', url => assertPublicHttpUrl(url)))
      .rejects.toThrow('did not end on a public website')
  })

  it('returns content when the final URL is public', async () => {
    const response = await chromiumQuickAction(clientEndingAt('https://www.example.com/'), 'markdown', 'https://example.com/', url => assertPublicHttpUrl(url))
    expect(await response.json()).toEqual({ result: 'secret' })
  })
})

describe('the local Chromium path', () => {
  const doh = (records: Record<string, Array<{ type: number, data: string }>>) => vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const type = url.searchParams.get('type') === 'A' ? 1 : 28
    return Response.json({ Answer: (records[url.searchParams.get('name')!] ?? []).filter(answer => answer.type === type || answer.type === 5) })
  }) as unknown as typeof fetch

  it('refuses a public-looking name that resolves to a private address', async () => {
    const fetcher = doh({
      '127.0.0.1.nip.io': [{ type: 1, data: '127.0.0.1' }],
      'mixed.example.com': [{ type: 1, data: '93.184.216.34' }, { type: 28, data: 'fd00::1' }],
      'mapped.example.com': [{ type: 28, data: '::ffff:10.0.0.1' }],
      'www.example.com': [{ type: 5, data: 'cdn.example.net.' }, { type: 1, data: '93.184.216.34' }],
    })
    await expect(assertPublicDestination('http://127.0.0.1.nip.io/', [], fetcher)).rejects.toThrow('not a public website')
    await expect(assertPublicDestination('https://mixed.example.com/', [], fetcher)).rejects.toThrow('not a public website')
    await expect(assertPublicDestination('https://mapped.example.com/', [], fetcher)).rejects.toThrow('not a public website')
    await expect(assertPublicDestination('https://nothing.example.com/', [], fetcher)).rejects.toThrow('not a public website')
    await expect(assertPublicDestination('https://www.example.com/', [], fetcher)).resolves.toBeUndefined()
  })

  it('refuses when the lookup fails, and skips it for a literal public address', async () => {
    const down = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await expect(assertPublicDestination('https://example.com/', [], down)).rejects.toThrow()
    await expect(assertPublicDestination('https://93.184.216.34/', [], down)).resolves.toBeUndefined()
    expect(down).toHaveBeenCalledTimes(2)
    await expect(assertPublicDestination('http://169.254.169.254/', [], down)).rejects.toThrow()
  })

  function pausingClient(requests: Array<{ url: string, resourceType: string }>) {
    const sent: Array<{ method: string, params?: Record<string, unknown> }> = []
    let listener: ((event: { method: string, sessionId: string, params: unknown }) => void) | undefined
    const client: CdpClient = {
      on(next) { listener = next as typeof listener; return () => { listener = undefined } },
      async send(method, params) {
        sent.push({ method, params })
        if (method === 'Target.createTarget') return { targetId: 't' }
        if (method === 'Target.attachToTarget') return { sessionId: 's' }
        if (method === 'Page.navigate') requests.forEach((request, index) => listener?.({ method: 'Fetch.requestPaused', sessionId: 's', params: { requestId: `r${index}`, request: { url: request.url }, resourceType: request.resourceType } }))
        if (method === 'Target.getTargetInfo') return { targetInfo: { url: 'https://example.com/' } }
        if (method === 'Runtime.evaluate') return { result: { value: 'text' } }
        return {}
      },
      async waitFor() { await new Promise(resolve => setTimeout(resolve, 20)) },
      async close() {},
    }
    return { client, sent }
  }
  const guard = async (url: string) => { if (new URL(url).hostname.endsWith('.nip.io')) throw new Error('private') }

  it('refuses a document that redirects to a private name, instead of reading it', async () => {
    const { client, sent } = pausingClient([{ url: 'https://example.com/', resourceType: 'Document' }, { url: 'http://127.0.0.1.nip.io/', resourceType: 'Document' }])
    await expect(chromiumQuickAction(client, 'markdown', 'https://example.com/', undefined, guard)).rejects.toThrow('did not end on a public website')
    await vi.waitFor(() => expect(sent.filter(call => call.method === 'Fetch.failRequest')).toEqual([expect.objectContaining({ params: { requestId: 'r1', errorReason: 'BlockedByClient' } })]))
    expect(sent.filter(call => call.method === 'Runtime.evaluate')).toEqual([])
    expect(sent.map(call => call.method).indexOf('Fetch.enable')).toBeLessThan(sent.map(call => call.method).indexOf('Page.navigate'))
    expect(sent.at(-1)?.method).toBe('Target.closeTarget')
  })

  it('fails only a private subresource, and lets inline data through unchecked', async () => {
    const { client, sent } = pausingClient([{ url: 'https://example.com/', resourceType: 'Document' }, { url: 'http://10.0.0.1.nip.io/a.png', resourceType: 'Image' }, { url: 'data:image/png;base64,AA', resourceType: 'Image' }])
    const response = await chromiumQuickAction(client, 'markdown', 'https://example.com/', undefined, guard)
    expect(await response.json()).toEqual({ result: 'text' })
    expect(sent.filter(call => call.method === 'Fetch.continueRequest').map(call => call.params?.requestId).sort()).toEqual(['r0', 'r2'])
    expect(sent.filter(call => call.method === 'Fetch.failRequest').map(call => call.params?.requestId)).toEqual(['r1'])
  })
})
