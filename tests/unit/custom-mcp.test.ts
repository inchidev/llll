import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture, remoteMcp } from '../helpers/outbound-mcp'
import { admitMcpConnections, mcpConnections, mcpRunBrief, mcpRunTools, refreshMcpConnection, saveMcpConnection } from '../../server/utils/outbound-mcp'
import { guardRunTool, privateContext, runReport } from '../../server/utils/agent-tool-security'
import { runAuthorization } from '../../server/utils/agent-run-service'
import { CUSTOM_MCP_PROVIDER, mcpEndpointProblem, mcpPaymentRequired, type McpConnectionInput } from '../../shared/outbound-mcp'
import type { AgentRun } from '../../shared/agent-execution'

const endpoint = 'https://coolify.acme.dev/mcp', tool = 'search_cloudflare_documentation'
let f: ReturnType<typeof mcpFixture>, remote: ReturnType<typeof remoteMcp>
beforeEach(() => { f = mcpFixture(); remote = remoteMcp() })
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

const custom = (extra: Partial<McpConnectionInput> = {}) => f.input({ name: 'Billing DB', providerId: CUSTOM_MCP_PROVIDER, endpoint, description: 'Customers and payments', toolNames: [], ...extra })
/** Save, list what the URL offers, choose, enable: what the Owner does in Settings. */
async function connectCustom(extra: Partial<McpConnectionInput> = {}) {
  const owner = await f.actor(), value = custom(extra)
  const saved = await saveMcpConnection(f.env, owner, value)
  await refreshMcpConnection(f.env, owner, saved.id)
  return saveMcpConnection(f.env, owner, { ...value, credential: undefined, credentialHeaders: undefined, toolNames: [tool], enabled: true }, saved.id)
}
const privateRead = (run: AgentRun, name = 'read_records') => f.db.prepare("INSERT INTO agent_run_tools(run_id,call_id,name,arguments_json,policy_json,status,result_json,created_at) VALUES(?,?,?,'{}','{}','completed','{}','2026-11-05')").run(run.id, crypto.randomUUID(), name)
const adapters = async (context: Awaited<ReturnType<typeof f.run>>) => mcpRunTools(f.env, context.authorization, context.run, undefined, async () => runAuthorization(f.env, context.run))

it.each([
  ['http://coolify.acme.dev/mcp'], ['https://user:secret@coolify.acme.dev/mcp'], ['https://coolify.acme.dev/mcp#fragment'], ['not a url'],
  ['https://127.0.0.1/mcp'], ['https://0x7f.1/mcp'], ['https://[::1]/mcp'], ['https://169.254.169.254/mcp'], ['https://10.0.0.5/mcp'],
  ['https://localhost/mcp'], ['https://db/mcp'], ['https://db.local/mcp'], ['https://db.internal/mcp'], ['https://db.test/mcp'], ['https://db.home.arpa/mcp'], ['https://localhost./mcp'],
])('refuses to save %s', url => { expect(mcpEndpointProblem(url)).toBeTruthy() })
it('accepts a public HTTPS URL with a port and query, and refuses the Server itself', () => {
  expect(mcpEndpointProblem('https://mcp.acme.dev:8443/mcp?codemode=false')).toBeNull()
  expect(mcpEndpointProblem('https://l4.acme.dev/mcp', 'https://l4.acme.dev')).toBeTruthy()
})

it('lets only the Owner connect a custom URL, and never as a personal connection', async () => {
  await expect(saveMcpConnection(f.env, await f.actor(ids.member), custom({ ownership: 'member', grants: { agentIds: [ids.agent], memberIds: [], roleIds: [] } }))).rejects.toMatchObject({ statusCode: 403 })
  await expect(saveMcpConnection(f.env, await f.actor(), custom({ ownership: 'member', grants: { agentIds: [ids.agent], memberIds: [], roleIds: [] } }))).rejects.toMatchObject({ statusCode: 403 })
  await expect(saveMcpConnection(f.env, await f.actor(), custom({ endpoint: 'https://10.0.0.5/mcp' }))).rejects.toMatchObject({ statusCode: 400 })
  await expect(saveMcpConnection(f.env, await f.actor(), custom(), undefined, 'https://coolify.acme.dev')).rejects.toMatchObject({ statusCode: 400 })
  expect(remote.network).not.toHaveBeenCalled()
})
it('binds a saved credential to its URL: the URL cannot change', async () => {
  const saved = await saveMcpConnection(f.env, await f.actor(), custom({ credential: 'synthetic-coolify-token' }))
  await expect(saveMcpConnection(f.env, await f.actor(), custom({ endpoint: 'https://evil.acme.dev/mcp' }), saved.id)).rejects.toMatchObject({ statusCode: 400 })
})
it('sends only to the saved URL, with a bearer token or a header pair, and redacts both from output', async () => {
  remote.state.resultText = 'id=access-id secret=access-secret'
  const connection = await connectCustom({ credentialHeaders: [{ name: 'CF-Access-Client-Id', value: 'access-id' }, { name: 'CF-Access-Client-Secret', value: 'access-secret' }] })
  expect(JSON.stringify(f.db.prepare('SELECT credential_json FROM mcp_outbound_connections').get())).not.toContain('access-secret')
  expect(connection).toMatchObject({ authKind: 'headers', hasCredential: true, endpoint })
  expect(JSON.stringify(await mcpConnections(f.env, await f.actor()))).not.toContain('access-secret')
  const context = await f.run()
  const [adapter] = await adapters(context)
  const output = await adapter!.execute({ query: 'paid' })
  expect(JSON.stringify(output)).not.toContain('access-secret')
  expect(remote.calls.every(call => call.url === endpoint)).toBe(true)
  const call = remote.calls.find(call => call.method === 'tools/call')!
  expect(call.headers.get('CF-Access-Client-Secret')).toBe('access-secret')
  expect(call.authorization).toBeNull()
})
it('offers read tools for choosing, hides tools that say they write, and enables only what was chosen', async () => {
  remote.state.extraTools = [{ name: 'execute_sql', annotations: { readOnlyHint: false, destructiveHint: true } }, { name: 'list_apps', annotations: {} }, { name: 'wipe', annotations: { destructiveHint: true } }]
  const owner = await f.actor(), saved = await saveMcpConnection(f.env, owner, custom())
  const found = await refreshMcpConnection(f.env, owner, saved.id)
  expect(found.hiddenWriteTools).toEqual(['execute_sql', 'wipe'])
  expect(found.connection.tools.map(item => item.remoteName)).toEqual([tool, 'list_apps'])
  await expect(saveMcpConnection(f.env, owner, custom({ enabled: true }), saved.id)).rejects.toMatchObject({ statusCode: 409 })
  await expect(saveMcpConnection(f.env, owner, custom({ toolNames: ['execute_sql'] }), saved.id)).rejects.toMatchObject({ statusCode: 400 })
  await saveMcpConnection(f.env, owner, custom({ toolNames: [tool], enabled: true }), saved.id)
  const context = await f.run()
  expect((await adapters(context)).map(adapter => adapter.tool.provenance?.remoteName)).toEqual([tool])
})
it('allows the readonly DBHub execute_sql that declares itself read-only', async () => {
  remote.state.extraTools = [{ name: 'execute_sql', annotations: { readOnlyHint: true, destructiveHint: false } }]
  const owner = await f.actor(), saved = await saveMcpConnection(f.env, owner, custom())
  const found = await refreshMcpConnection(f.env, owner, saved.id)
  expect(found.connection.tools.find(item => item.remoteName === 'execute_sql')?.declaredReadOnly).toBe(true)
})
it('never treats another L4 write tool as a read, whatever it claims', async () => {
  remote.state.serverName = 'L4'
  remote.state.extraTools = [{ name: 'send_message', annotations: { readOnlyHint: true } }, { name: 'list_tasks', annotations: { readOnlyHint: true } }]
  const owner = await f.actor(), saved = await saveMcpConnection(f.env, owner, custom())
  const found = await refreshMcpConnection(f.env, owner, saved.id)
  expect(found.hiddenWriteTools).toEqual(['send_message'])
})
it('stops a call when a chosen tool later declares it writes', async () => {
  await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  remote.state.annotations = { readOnlyHint: false }
  await expect(adapter!.execute({ query: 'paid' })).rejects.toMatchObject({ statusCode: 409 })
  expect(remote.calls.some(call => call.method === 'tools/call')).toBe(false)
})
it('stops a call when a chosen tool changes its schema', async () => {
  await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  remote.state.schema = { type: 'object', properties: { query: { type: 'string' }, extra: { type: 'string' } } }
  await expect(adapter!.execute({ query: 'paid' })).rejects.toMatchObject({ statusCode: 409 })
  expect(remote.calls.some(call => call.method === 'tools/call')).toBe(false)
})

it('reaches the tool after private data, and a Task Run may use it', async () => {
  await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  privateRead(context.run)
  expect(await privateContext(f.env, context.run)).toBe(true)
  await expect(guardRunTool(f.env, context.run, adapter!.tool.name)).resolves.toBeUndefined()
  await expect(guardRunTool(f.env, context.run, adapter!.tool.name)).resolves.toBeUndefined()
})
it('still blocks a public catalog connection after private data', async () => {
  const docs = await f.connect()
  const context = await f.run(ids.owner, [docs.id]), [adapter] = await adapters(context)
  privateRead(context.run)
  await expect(guardRunTool(f.env, context.run, adapter!.tool.name)).rejects.toMatchObject({ statusCode: 403 })
})
it('closes the open internet after reading a custom connection, even once the connection is gone', async () => {
  const connection = await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  await expect(guardRunTool(f.env, context.run, 'read_url')).resolves.toBeUndefined()
  await guardRunTool(f.env, context.run, adapter!.tool.name)
  await expect(guardRunTool(f.env, context.run, 'read_url')).rejects.toMatchObject({ statusCode: 403 })
  await expect(guardRunTool(f.env, context.run, 'search_web')).rejects.toMatchObject({ statusCode: 403 })
  f.db.prepare('DELETE FROM mcp_outbound_connections WHERE id=?').run(connection.id)
  await expect(guardRunTool(f.env, context.run, 'read_url')).rejects.toMatchObject({ statusCode: 403 })
})
it('posts the answer where the question was asked', async () => {
  await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  await guardRunTool(f.env, context.run, adapter!.tool.name)
  const answer = { ...context.run, status: 'completed', resultText: 'Paid customers: 42' } as AgentRun
  expect(await runReport(f.env, answer)).toEqual({ restricted: false, text: 'Paid customers: 42' })
})
it('keeps built-in private sources behind a link in a shared channel', async () => {
  await connectCustom()
  const context = await f.run()
  privateRead(context.run, 'get_task')
  const answer = { ...context.run, status: 'completed', resultText: 'Private task content' } as AgentRun
  const report = await runReport(f.env, answer)
  expect(report.restricted).toBe(true)
  expect(report.text).not.toContain('Private task content')
})
it('does not mark another person: a mixed conversation starts clean', async () => {
  await connectCustom({ grants: { agentIds: [ids.agent], memberIds: [ids.owner, ids.member], roleIds: [] } })
  const owner = await f.run(), [adapter] = await adapters(owner)
  await guardRunTool(f.env, owner.run, adapter!.tool.name)
  privateRead(owner.run)
  const member = await f.run(ids.member)
  expect(member.run.sessionId).toBe(owner.run.sessionId)
  expect(await privateContext(f.env, member.run)).toBe(false)
  await expect(guardRunTool(f.env, member.run, 'read_url')).resolves.toBeUndefined()
  // Their own Run still holds what it read.
  expect(await privateContext(f.env, owner.run)).toBe(true)
})
it('keeps the mark across Runs of one person, whose transcript carries the data', async () => {
  await connectCustom()
  const first = await f.run(), [adapter] = await adapters(first)
  await guardRunTool(f.env, first.run, adapter!.tool.name)
  const second = await f.run()
  expect(await privateContext(f.env, second.run)).toBe(true)
  await expect(guardRunTool(f.env, second.run, 'read_url')).rejects.toMatchObject({ statusCode: 403 })
})
it('gives no tool to a person without the grant, and removing the grant stops the next call', async () => {
  const connection = await connectCustom()
  expect(await adapters(await f.run(ids.member))).toEqual([])
  const context = await f.run(), [adapter] = await adapters(context)
  f.db.prepare('DELETE FROM grants WHERE connection_id=? AND member_id=?').run(connection.id, ids.owner)
  await expect(adapter!.execute({ query: 'paid' })).rejects.toMatchObject({ statusCode: 403 })
  expect(remote.calls.some(call => call.method === 'tools/call')).toBe(false)
})
it('does not fail a question in chat with many connections', async () => {
  for (let index = 0; index < 8; index++) await connectCustom({ name: `Source ${index}` })
  const context = await f.run()
  expect((JSON.parse(context.run.mandateJson) as { toolConnections: unknown[] }).toolConnections).toHaveLength(8)
  await expect(admitMcpConnections(f.env, context.authorization)).resolves.toHaveLength(8)
})
it('tells the model what its connections hold', async () => {
  await connectCustom()
  const context = await f.run()
  expect(await mcpRunBrief(f.env, context.authorization, context.run)).toContain('Billing DB: Customers and payments')
  expect((await adapters(context))[0]!.tool.description).toContain('Customers and payments')
})

const payment = { x402Version: 2, error: 'Pay me', accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '10000', payTo: '0xabc' }] }
it('recognises a payment request strictly', () => {
  expect(mcpPaymentRequired({ structuredContent: payment })).toBe(true)
  expect(mcpPaymentRequired({ content: [{ type: 'text', text: JSON.stringify(payment) }] })).toBe(true)
  expect(mcpPaymentRequired({ structuredContent: { x402Version: 2, accepts: [] } })).toBe(false)
  expect(mcpPaymentRequired({ structuredContent: { accepts: [{}] } })).toBe(false)
  expect(mcpPaymentRequired({ content: [{ type: 'text', text: 'x402Version accepts' }] })).toBe(false)
})
it('reports a payment request without forwarding remote text or paying', async () => {
  await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  remote.state.callResult = { isError: true, structuredContent: payment, content: [{ type: 'text', text: JSON.stringify(payment) }] }
  const error = await adapter!.execute({ query: 'paid' }).catch(cause => cause)
  expect(error).toMatchObject({ statusCode: 402, data: { error: { code: 'mcp_payment_required' } } })
  expect(JSON.stringify(error.data)).not.toContain('Pay me')
  const audit = f.db.prepare("SELECT meta_json AS meta FROM audit_log WHERE action='tool.connection.call'").get() as { meta: string }
  expect(JSON.parse(audit.meta).status).toBe('payment_required')
})
it('still hides an ordinary remote failure', async () => {
  await connectCustom()
  const context = await f.run(), [adapter] = await adapters(context)
  remote.state.callResult = { isError: true, content: [{ type: 'text', text: 'internal stack trace' }] }
  const error = await adapter!.execute({ query: 'paid' }).catch(cause => cause)
  expect(error).toMatchObject({ statusCode: 502, data: { error: { code: 'mcp_unavailable' } } })
  expect(JSON.stringify(error.data)).not.toContain('stack trace')
})
