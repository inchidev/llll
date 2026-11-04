import { expect, it } from 'vitest'
import { boundedMcpOutput, MCP_OUTPUT_BYTES } from '../../server/utils/outbound-mcp-output'
const payload = (text: string, structuredContent?: unknown) => ({ connection: { id: 'connection-id', name: 'Docs', providerId: 'cloudflare-docs' }, tool: 'search_cloudflare_documentation', schemaHash: 'reviewed-hash', observedAt: '2026-10-25T00:00:00Z', warning: 'Untrusted external data.', content: [{ type: 'text' as const, text }], structuredContent })
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
it('keeps complete text and structured results when both fit', () => {
  const source = payload('Verified source', { answer: 'Verified source' })
  expect(boundedMcpOutput(source, null)).toEqual(source)
})
it('preserves complete evidence when the remote server duplicates it in structured content', () => {
  const text = 'https://developers.cloudflare.com/workers/\n' + 'e'.repeat(34000)
  const result = boundedMcpOutput(payload(text, { answer: text }), null)
  expect(result.content[0]!.text).toBe(text)
  expect(result.structuredContent).toBeUndefined()
  expect(result).toMatchObject({ truncated: true, structuredContentOmitted: true, connection: { id: 'connection-id' }, schemaHash: 'reviewed-hash' })
  expect(size(result)).toBeLessThanOrEqual(MCP_OUTPUT_BYTES)
})
it.each(['x'.repeat(100000), '😀引用\n"\\'.repeat(15000)])('returns valid bounded text excerpts for large escaped or multibyte output', text => {
  const result = boundedMcpOutput(payload(text), null)
  expect(size(result)).toBeLessThanOrEqual(MCP_OUTPUT_BYTES)
  expect(size(result)).toBeGreaterThan(MCP_OUTPUT_BYTES - 100)
  expect(result.truncated).toBe(true)
  expect(result.content[0]!.text).toContain('[Output truncated by L4]')
  expect(result.warning).toContain('not the complete response')
  expect(JSON.parse(JSON.stringify(result)).schemaHash).toBe('reviewed-hash')
})
it('redacts the full secret before an excerpt boundary can split it', () => {
  const token = 'synthetic-secret-at-excerpt-boundary'
  const result = boundedMcpOutput(payload(('x'.repeat(1000) + token).repeat(100)), token)
  expect(size(result)).toBeLessThanOrEqual(MCP_OUTPUT_BYTES)
  expect(JSON.stringify(result)).not.toContain(token)
  expect(result.content[0]!.text).toContain('[redacted]')
})
it('bounds many text blocks and omits large structured-only results explicitly', () => {
  const many = { ...payload(''), content: Array.from({ length: 20 }, () => ({ type: 'text' as const, text: 'e'.repeat(10000) })) }
  const result = boundedMcpOutput(many, null)
  expect(size(result)).toBeLessThanOrEqual(MCP_OUTPUT_BYTES)
  expect(result.content.length).toBeLessThan(20)
  const structured = boundedMcpOutput(payload('', { results: 'x'.repeat(70000) }), null)
  expect(structured).toMatchObject({ truncated: true, structuredContentOmitted: true })
  expect(structured.warning).toContain('do not infer missing fields')
})
