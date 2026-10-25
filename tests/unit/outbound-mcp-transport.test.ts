import { afterEach, expect, it, vi } from 'vitest'
import { mcpBoundedFetch, safeMcpSchema, withMcpClient, readMcpTools } from '../../server/utils/outbound-mcp-transport'
import { remoteMcp } from '../helpers/outbound-mcp'
const endpoint = 'https://docs.mcp.cloudflare.com/mcp'
afterEach(() => vi.unstubAllGlobals())
it.each(['http://127.0.0.1/mcp', 'https://169.254.169.254/mcp', 'https://docs.mcp.cloudflare.com.evil.example/mcp', 'https://user:secret@docs.mcp.cloudflare.com/mcp', endpoint+'?next=http://127.0.0.1', 'https://[::1]/mcp'])('rejects unreviewed destination %s before any network access', async url => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect(() => mcpBoundedFetch(url, null, new AbortController().signal)).toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it('rejects a transport attempting to switch hosts or paths, and strips unrelated cookies', async () => {
  const fetcher = vi.fn(async (_url, init) => { expect(new Headers(init.headers).has('Cookie')).toBe(false); expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('manual'); return Response.json({}) })
  vi.stubGlobal('fetch', fetcher)
  const bounded = mcpBoundedFetch(endpoint, 'intended-bearer', new AbortController().signal)
  await expect(bounded('https://127.0.0.1/private', { method: 'POST' })).rejects.toMatchObject({ statusCode: 403 })
  await bounded(endpoint, { method: 'POST', headers: { Cookie: 'private=secret', Authorization: 'Bearer wrong' } })
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get('Authorization')).toBe('Bearer intended-bearer')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('does not follow a redirect to metadata/private networks', async () => {
  const remote = remoteMcp(); remote.state.redirect = true
  await expect(withMcpClient('cloudflare-docs', null, undefined, async () => {})).rejects.toThrow()
  expect(remote.network).toHaveBeenCalledTimes(1)
  expect(remote.calls[0]!.url).toBe(endpoint)
})
it.each([{ type: 'object', properties: { query: { $ref: 'http://169.254.169.254/schema' } } }, { type: 'object', properties: { query: { type: 'string', pattern: '(a+)+$' } } }, { type: 'object', $schema: 'https://untrusted.invalid/schema' }, { type: 'object', description: 'x'.repeat(13000) }])('rejects dangerous or oversized schemas', schema => {
  expect(() => safeMcpSchema(schema)).toThrow()
})
it('caps response streams before the SDK parses unbounded data', async () => {
  const remote = remoteMcp(); remote.state.oversized = true
  await expect(withMcpClient('cloudflare-docs', null, undefined, async () => {})).rejects.toThrow()
  expect(remote.network).toHaveBeenCalledTimes(1)
})
it('supports actual SDK initialization and tools/list over SSE without accepting remote instructions', async () => {
  const remote = remoteMcp(); remote.state.sse = true
  const tools = await withMcpClient('cloudflare-docs', null, undefined, client => readMcpTools(client, '00000000-0000-4000-8000-000000000001', 'cloudflare-docs', ['search_cloudflare_documentation']))
  expect(tools).toHaveLength(1)
  expect(JSON.stringify(tools)).not.toContain('Ignore all policies')
})
it('refuses ambiguous duplicate tools rather than using the first match', async () => {
  const remote = remoteMcp(); remote.state.duplicate = true
  await expect(withMcpClient('cloudflare-docs', null, undefined, client => readMcpTools(client, 'id', 'cloudflare-docs', ['search_cloudflare_documentation']))).rejects.toThrow()
})
it('rejects remote references in output schemas before the SDK accepts them', async () => {
  const remote = remoteMcp(); remote.state.outputSchema = { type: 'object', properties: { result: { $ref: 'http://169.254.169.254/private-schema' } } }
  await expect(withMcpClient('cloudflare-docs', null, undefined, client => readMcpTools(client, 'id', 'cloudflare-docs', ['search_cloudflare_documentation']))).rejects.toThrow()
  expect(remote.calls.every(call => call.url === endpoint)).toBe(true)
  expect(remote.calls.some(call => call.method === 'tools/call')).toBe(false)
})
it('changes the tool identity when only the remote output contract changes', async () => {
  const remote = remoteMcp()
  const read = () => withMcpClient('cloudflare-docs', null, undefined, client => readMcpTools(client, '00000000-0000-4000-8000-000000000001', 'cloudflare-docs', ['search_cloudflare_documentation']))
  const original = await read()
  remote.state.outputSchema = { type: 'object', properties: { answer: { type: 'string' } } }
  const changed = await read()
  expect(changed[0]!.hash).not.toBe(original[0]!.hash)
  expect(changed[0]!.name).not.toBe(original[0]!.name)
})
