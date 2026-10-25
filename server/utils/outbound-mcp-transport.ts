import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { outboundMcpProviders, type McpToolSnapshot } from '../../shared/outbound-mcp'
import { fail } from './cf'

const baseValidator = new CfWorkerJsonSchemaValidator()
export const mcpValidator = {
  getValidator<T>(schema: Parameters<CfWorkerJsonSchemaValidator['getValidator']>[0]) {
    return baseValidator.getValidator<T>(safeMcpSchema(schema))
  },
}
const encoder = new TextEncoder()
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export async function mcpSchemaHash(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** No remote references, regex evaluation or unbounded schema trees. */
export function safeMcpSchema(schema: unknown): Record<string, unknown> {
  let nodes = 0
  function visit(value: unknown, depth: number) {
    if (++nodes > 1000 || depth > 12) fail(422, 'mcp_schema_invalid', 'MCP schema exceeds its complexity limit')
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', 'pattern', 'patternProperties', 'contentSchema', '__proto__', 'constructor', 'prototype'].includes(key)) fail(422, 'mcp_schema_invalid', 'MCP schema uses an unsupported keyword')
      visit(item, depth + 1)
    }
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema as Record<string, unknown>).type !== 'object'
    || encoder.encode(JSON.stringify(schema)).byteLength > 12000) fail(422, 'mcp_schema_invalid', 'MCP tool arguments need a bounded object schema')
  visit(schema, 0)
  try { baseValidator.getValidator(schema) } catch { fail(422, 'mcp_schema_invalid', 'MCP tool schema is unsupported') }
  return schema as Record<string, unknown>
}

/** Exact reviewed HTTPS endpoints only. No redirects, OAuth discovery, GET streams or local commands. */
export function mcpBoundedFetch(endpoint: string, token: string | null, signal: AbortSignal, rejected: () => void = () => {}): typeof fetch {
  if (!outboundMcpProviders.some(provider => provider.endpoint === endpoint)) fail(403, 'mcp_destination', 'MCP destination is not in the reviewed catalog')
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).href !== endpoint) fail(403, 'mcp_destination', 'MCP changed its authorized destination')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method === 'GET') return new Response(null, { status: 405 })
    if (method !== 'POST') fail(403, 'mcp_method', 'Only MCP protocol POST requests are supported')
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    // Overwrite rather than inherit any credential or cookies supplied by a transport.
    headers.delete('Cookie'); headers.delete('Authorization')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    signal.throwIfAborted()
    const response = await fetch(endpoint, { ...init, method: 'POST', headers, credentials: 'omit', redirect: 'manual',
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail(502, 'mcp_redirect', 'MCP redirects are disabled') }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); rejected(); fail(409, 'mcp_credentials', 'MCP credentials expired or no longer grant access') }
    const reader = response.body?.getReader()
    let bytes = 0
    const body = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read()
          if (item.done) { controller.close(); return }
          bytes += item.value.byteLength
          if (bytes > 256000) { await reader.cancel(); controller.error(new Error('MCP response limit')); return }
          controller.enqueue(item.value)
        } catch { controller.error(new Error('MCP response unavailable')) }
      },
      cancel: reason => reader.cancel(reason),
    }) : null
    return new Response(body, { status: response.status, headers: response.headers })
  }
}

export async function withMcpClient<T>(providerId: string, token: string | null, signal: AbortSignal | undefined, action: (client: Client) => Promise<T>): Promise<T> {
  const provider = outboundMcpProviders.find(provider => provider.id === providerId)
  if (!provider) fail(409, 'mcp_unavailable', 'MCP provider is no longer available')
  const bounded = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
  // Each operation owns its client/session/request IDs. No shared transport across users or connections.
  const client = new Client({ name: 'L4 read-only tool broker', version: '1' }, { capabilities: {}, jsonSchemaValidator: mcpValidator })
  let credentialsRejected = false
  const transport = new StreamableHTTPClientTransport(new URL(provider.endpoint), {
    fetch: mcpBoundedFetch(provider.endpoint, token, bounded, () => { credentialsRejected = true }), requestInit: { redirect: 'manual', signal: bounded },
    onInsufficientScope: 'throw', reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  })
  try {
    await client.connect(transport, { timeout: 10000, signal: bounded })
    return await action(client)
  } catch (error) {
    if (credentialsRejected) fail(409, 'mcp_credentials', 'MCP credentials no longer grant access')
    throw error
  } finally { await client.close().catch(() => undefined) }
}

export async function readMcpTools(client: Client, connectionId: string, providerId: string, names: string[]): Promise<McpToolSnapshot[]> {
  const provider = outboundMcpProviders.find(provider => provider.id === providerId)!
  const listed = await client.listTools({}, { timeout: 10000 })
  if (listed.nextCursor || listed.tools.length > 40 || new Set(listed.tools.map(tool => tool.name)).size !== listed.tools.length) fail(422, 'mcp_catalog_large', 'MCP tool list is too large or ambiguous')
  const result: McpToolSnapshot[] = []
  for (const remote of listed.tools) {
    if (!names.includes(remote.name) || !(provider.readTools as readonly string[]).includes(remote.name) || remote.annotations?.readOnlyHint === false) continue
    const parameters = safeMcpSchema(remote.inputSchema)
    const description = String(remote.description ?? remote.name).slice(0, 700)
    const outputSchema = remote.outputSchema ? safeMcpSchema(remote.outputSchema) : null
    const hash = await mcpSchemaHash({ name: remote.name, description, parameters, outputSchema })
    const slug = remote.name.toLowerCase().replace(/[^a-z0-9_]/gu, '_').slice(0, 18)
    result.push({ name: `mcp_${connectionId.replaceAll('-', '')}_${hash.slice(0, 8)}_${slug}`, remoteName: remote.name, description, parameters, hash })
  }
  if (!result.length) fail(409, 'mcp_no_read_tools', 'MCP exposes none of the explicitly permitted read-only tools')
  return result
}
