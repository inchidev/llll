import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { CUSTOM_MCP_PROVIDER, mcpCredentialHeaders, mcpEndpointProblem, outboundMcpProviders, type McpToolSnapshot } from '../../shared/outbound-mcp'
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

/** A bearer token, or the header pair a service such as Cloudflare Access expects. */
export type McpAuth = string | Record<string, string> | null
export const mcpAuthSecrets = (auth: McpAuth): string[] => !auth ? [] : typeof auth === 'string' ? [auth] : Object.values(auth)

/** One exact HTTPS endpoint: reviewed, or the Owner's saved URL. No redirects, OAuth discovery, GET streams or local commands. */
export function mcpBoundedFetch(endpoint: string, auth: McpAuth, signal: AbortSignal, rejected: () => void = () => {}, custom = false): typeof fetch {
  if (custom ? mcpEndpointProblem(endpoint) : !outboundMcpProviders.some(provider => provider.endpoint === endpoint)) fail(403, 'mcp_destination', 'MCP destination is not permitted')
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).href !== endpoint) fail(403, 'mcp_destination', 'MCP changed its authorized destination')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method === 'GET') return new Response(null, { status: 405 })
    if (method !== 'POST') fail(403, 'mcp_method', 'Only MCP protocol POST requests are supported')
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    // Overwrite rather than inherit any credential or cookies supplied by a transport.
    headers.delete('Cookie'); headers.delete('Authorization')
    for (const name of mcpCredentialHeaders) headers.delete(name)
    if (typeof auth === 'string') headers.set('Authorization', `Bearer ${auth}`)
    else if (auth) for (const [name, value] of Object.entries(auth)) headers.set(name, value)
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

export type McpTarget = { providerId: string; endpoint?: string | null }
export async function withMcpClient<T>(target: string | McpTarget, auth: McpAuth, signal: AbortSignal | undefined, action: (client: Client) => Promise<T>): Promise<T> {
  const { providerId, endpoint: saved } = typeof target === 'string' ? { providerId: target, endpoint: null } : target
  const custom = providerId === CUSTOM_MCP_PROVIDER
  const endpoint = custom ? saved : outboundMcpProviders.find(provider => provider.id === providerId)?.endpoint
  if (!endpoint) fail(409, 'mcp_unavailable', 'MCP provider is no longer available')
  const bounded = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
  // Each operation owns its client/session/request IDs. No shared transport across users or connections.
  const client = new Client({ name: 'L4 read-only tool broker', version: '1' }, { capabilities: {}, jsonSchemaValidator: mcpValidator })
  let credentialsRejected = false
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: mcpBoundedFetch(endpoint, auth, bounded, () => { credentialsRejected = true }, custom), requestInit: { redirect: 'manual', signal: bounded },
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

type RemoteTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]
async function snapshot(remote: RemoteTool, connectionId: string, custom: boolean): Promise<McpToolSnapshot> {
  const parameters = safeMcpSchema(remote.inputSchema)
  const description = String(remote.description ?? remote.name).slice(0, 700)
  const outputSchema = remote.outputSchema ? safeMcpSchema(remote.outputSchema) : null
  const declaredReadOnly = remote.annotations?.readOnlyHint === true
  const hash = await mcpSchemaHash({ name: remote.name, description, parameters, outputSchema, ...(custom ? { declaredReadOnly } : {}) })
  const slug = remote.name.toLowerCase().replace(/[^a-z0-9_]/gu, '_').slice(0, 18)
  return { name: `mcp_${connectionId.replaceAll('-', '')}_${hash.slice(0, 8)}_${slug}`, remoteName: remote.name, description, parameters, hash, ...(custom ? { declaredReadOnly } : {}) }
}

const MAX_CUSTOM_TOOLS = 200, MAX_CUSTOM_PAGES = 5, MAX_CUSTOM_CATALOG_BYTES = 512_000
const l4WriteTool = /^(send|create|update|delete|move|mark|add|remove|set)_/u
/** External writes wait for exact human approval, which does not exist yet: a tool that says it writes stays out. */
function declaresWrite(client: Client, remote: RemoteTool) {
  return remote.annotations?.readOnlyHint === false || remote.annotations?.destructiveHint === true
    // A self-reported name can only make this stricter. Another L4's writes must never run on a label.
    || (client.getServerVersion()?.name === 'L4' && l4WriteTool.test(remote.name))
}
async function listCustomTools(client: Client) {
  const tools: RemoteTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_CUSTOM_PAGES; page++) {
    const listed = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 })
    tools.push(...listed.tools)
    if (tools.length > MAX_CUSTOM_TOOLS) fail(422, 'mcp_catalog_large', 'MCP tool list is too large')
    cursor = listed.nextCursor
    if (!cursor) break
  }
  if (cursor || new Set(tools.map(tool => tool.name)).size !== tools.length) fail(422, 'mcp_catalog_large', 'MCP tool list is too large or ambiguous')
  return tools
}
/** Every tool an Owner may choose on a custom connection. Remote text is stored as data, never as authority. */
export async function discoverMcpTools(client: Client, connectionId: string) {
  const listed = await listCustomTools(client)
  const readable = listed.filter(remote => !declaresWrite(client, remote))
  const tools = await Promise.all(readable.map(remote => snapshot(remote, connectionId, true)))
  if (new TextEncoder().encode(JSON.stringify(tools)).byteLength > MAX_CUSTOM_CATALOG_BYTES) fail(422, 'mcp_catalog_large', 'MCP tool list is too large')
  return { tools, hiddenWriteTools: listed.filter(remote => declaresWrite(client, remote)).map(remote => remote.name).slice(0, 50) }
}

export async function readMcpTools(client: Client, connectionId: string, providerId: string, names: string[]): Promise<McpToolSnapshot[]> {
  if (providerId === CUSTOM_MCP_PROVIDER) {
    const listed = (await listCustomTools(client)).filter(remote => names.includes(remote.name) && !declaresWrite(client, remote))
    return Promise.all(listed.map(remote => snapshot(remote, connectionId, true)))
  }
  const provider = outboundMcpProviders.find(provider => provider.id === providerId)!
  const listed = await client.listTools({}, { timeout: 10000 })
  if (listed.nextCursor || listed.tools.length > 40 || new Set(listed.tools.map(tool => tool.name)).size !== listed.tools.length) fail(422, 'mcp_catalog_large', 'MCP tool list is too large or ambiguous')
  const result: McpToolSnapshot[] = []
  for (const remote of listed.tools) {
    if (!names.includes(remote.name) || !(provider.readTools as readonly string[]).includes(remote.name) || remote.annotations?.readOnlyHint === false) continue
    result.push(await snapshot(remote, connectionId, false))
  }
  if (!result.length) fail(409, 'mcp_no_read_tools', 'MCP exposes none of the explicitly permitted read-only tools')
  return result
}
