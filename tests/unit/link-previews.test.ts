import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../shared/markdown'
import { previewLinks, internalLinkTarget } from '../../shared/link-previews'
import { isSearchShortcut, isConversationSearchShortcut } from '../../shared/shortcuts'
import { pageMetadata } from '../../server/utils/link-previews'
import { boundedBytes, decodePreviewResponse, fetchPreview } from '../../server/utils/preview-fetch'

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('cloudflare:sockets', () => ({ connect }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
const encode = (text: string) => new TextEncoder().encode(text)

describe('visible Markdown links', () => {
  it('deduplicates and unescapes links, preserving internal deep links', () => {
    const html = renderMarkdown('[page](/items/one) https://example.com/?a=1&b=2 https://example.com/?a=1&b=2')
    expect(previewLinks(html)).toEqual(['/items/one', 'https://example.com/?a=1&b=2'])
    expect(internalLinkTarget(new URL('https://server.test/projects/board?board=b&task=t'))).toEqual({ type: 'task', id: 't' })
  })
  it('never fetches code or spoilers containing nested mentions and formatting', () => {
    const html = renderMarkdown('`https://code.test`\n```\nhttps://fence.test\n```\n||<!here> **secret** https://secret.test|| https://public.test')
    expect(previewLinks(html)).toEqual(['https://public.test'])
  })
  it('limits cards and excludes protocol-relative and non-HTTP links', () => {
    expect(previewLinks(renderMarkdown('[mail](mailto:a@b.com) [other](//example.com) https://a.test https://b.test https://c.test https://d.test'))).toEqual(['https://a.test', 'https://b.test', 'https://c.test'])
  })
})

describe('search shortcuts', () => {
  it('reserves Cmd/Ctrl+K globally and Cmd/Ctrl+Shift+F for conversation search', () => {
    expect(isSearchShortcut({ key: 'k', metaKey: true })).toBe(true)
    expect(isSearchShortcut({ key: 'K', ctrlKey: true })).toBe(true)
    expect(isSearchShortcut({ key: 'k', metaKey: true, shiftKey: true })).toBe(false)
    expect(isSearchShortcut({ key: 'k', metaKey: true, isComposing: true })).toBe(false)
    expect(isConversationSearchShortcut({ key: 'F', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(isConversationSearchShortcut({ key: 'f', metaKey: true })).toBe(false)
  })
})

describe('metadata and bounded HTTP', () => {
  it('prefers social metadata, decodes entities and never returns active markup', () => {
    expect(pageMetadata('<title>Fallback</title><meta property="og:title" content="A &amp; B"><meta name="description" content="&lt;b&gt;Hello&lt;/b&gt;"><meta property="og:image" content="/image.png">')).toEqual({ title: 'A & B', description: 'Hello', image: '/image.png' })
    expect(pageMetadata('<title>Fallback &amp; title</title>').title).toBe('Fallback & title')
  })
  it('bounds titles and strips scripts', () => {
    expect(pageMetadata(`<title>${'x'.repeat(300)}</title>`).title).toHaveLength(240)
    expect(pageMetadata('<script>secret()</script>').title).toBe('')
  })
  it('enforces body limits with and without Content-Length', async () => {
    await expect(boundedBytes(new Response('large'), 3)).rejects.toThrow('too large')
    await expect(boundedBytes(new Response('x', { headers: { 'content-length': '1000' } }), 3)).rejects.toThrow('too large')
  })
  it('decodes chunked responses and rejects truncated or ambiguous framing', async () => {
    expect(await decodePreviewResponse(encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\n\r\n'), 10).text()).toBe('onetwo')
    expect(() => decodePreviewResponse(encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx'), 10)).toThrow('Incomplete')
    expect(() => decodePreviewResponse(encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n'), 10)).toThrow('framing')
    expect(() => decodePreviewResponse(encode('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nx'), 10)).toThrow('encoding')
    expect(() => decodePreviewResponse(encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n'), 10)).toThrow('ending')
  })
})

describe('public-only fetching', () => {
  it.each(['http://127.0.0.1', 'http://[::1]', 'http://169.254.169.254/latest', 'https://user:pass@example.com', 'https://example.com:8443', 'http://0x7f000001'])('refuses %s before network access', async url => {
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await expect(fetchPreview(url, [], 1000, new AbortController().signal)).rejects.toThrow()
    expect(network).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
  it('checks every edge redirect and does not forward credentials', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://10.0.0.1' } }))
    vi.stubGlobal('fetch', network)
    await expect(fetchPreview('https://example.com', [], 1000, new AbortController().signal, true)).rejects.toThrow('public website')
    expect(network).toHaveBeenCalledTimes(1)
    expect(network.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', credentials: 'omit' })
  })
  it('refuses a mixed public/private DNS answer on self-host', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }, { type: 1, data: '10.0.0.1' }] })))
    await expect(fetchPreview('https://example.com', [], 1000, new AbortController().signal)).rejects.toThrow('public website')
    expect(connect).not.toHaveBeenCalled()
  })
  it('pins the resolved IP while retaining the original TLS hostname and Host header on self-host', async () => {
    // celld uses this UA too; its explicit runtime still selects the pinned transport.
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    const network = vi.fn().mockResolvedValue(Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] }))
    vi.stubGlobal('fetch', network)
    const write = vi.fn()
    const socket = {
      opened: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined), startTls: vi.fn(),
      writable: new WritableStream({ write }),
      readable: new ReadableStream({ start(controller) { controller.enqueue(encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')); controller.close() } }),
    }
    socket.startTls.mockReturnValue(socket)
    connect.mockReturnValue(socket)
    expect(await (await fetchPreview('https://example.com/page?q=1', [], 1000, new AbortController().signal, false)).text()).toBe('OK')
    expect(connect).toHaveBeenCalledWith({ hostname: '93.184.216.34', port: 443 }, expect.anything())
    expect(socket.startTls).toHaveBeenCalledWith({ expectedServerHostname: 'example.com' })
    expect(new TextDecoder().decode(write.mock.calls[0]?.[0])).toContain('Host: example.com\r\n')
    expect(network).toHaveBeenCalledTimes(1) // Only the fixed DNS resolver; no hostname re-resolution.
    expect(socket.close).toHaveBeenCalled()
  })
})
