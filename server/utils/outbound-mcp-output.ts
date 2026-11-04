type McpOutput = {
  connection: { id: string; name: string; providerId: string }
  tool: string; schemaHash: string; observedAt: string; warning: string
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  truncated?: boolean
  structuredContentOmitted?: boolean
}
const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
export const MCP_OUTPUT_BYTES = 64000
export const mcpSecretForms = (token: string) => [token, encodeURIComponent(token), btoa(token)]

/** Redact complete secrets before taking excerpts; retain a valid attributed envelope. */
export function boundedMcpOutput(value: McpOutput, token: string | null): McpOutput {
  let encoded = JSON.stringify(value)
  if (token) for (const secret of mcpSecretForms(token)) encoded = encoded.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]')
  const output = JSON.parse(encoded) as McpOutput
  if (bytes(output) <= MCP_OUTPUT_BYTES) return output

  // MCP servers often duplicate text in structuredContent. Prefer complete text
  // evidence before shortening it, and disclose every omitted representation.
  if (output.structuredContent !== undefined) {
    delete output.structuredContent
    output.structuredContentOmitted = true
    output.truncated = true
    output.warning += ' Structured content was omitted to fit the output limit; do not infer missing fields.'
    if (bytes(output) <= MCP_OUTPUT_BYTES) return output
  }
  const content = output.content
  output.content = []
  output.truncated = true
  output.warning += ' Text is a bounded excerpt, not the complete response. Missing evidence may require a narrower query.'
  if (bytes(output) > MCP_OUTPUT_BYTES) throw new Error('MCP provenance exceeds its output limit')
  for (const item of content.slice(0, 32)) {
    output.content.push(item)
    if (bytes(output) <= MCP_OUTPUT_BYTES) continue
    output.content.pop()
    let low = 0, high = item.text.length
    const excerpt = (length: number) => {
      let text = item.text.slice(0, length)
      if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1)
      return { type: 'text' as const, text: text + '\n[Output truncated by L4]' }
    }
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (bytes({ ...output, content: [...output.content, excerpt(mid)] }) <= MCP_OUTPUT_BYTES) low = mid
      else high = mid - 1
    }
    const last = excerpt(low)
    if (bytes({ ...output, content: [...output.content, last] }) <= MCP_OUTPUT_BYTES) output.content.push(last)
    break
  }
  return output
}
