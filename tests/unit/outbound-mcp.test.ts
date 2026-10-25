import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture, remoteMcp, grant } from '../helpers/outbound-mcp'
import { mcpConnections, saveMcpConnection, refreshMcpConnection, admitMcpConnections } from '../../server/utils/outbound-mcp'
import { toolsForRun, executeRunTool } from '../../server/utils/agent-tools'
import { Permission, rolePermissions } from '../../shared/permissions'

let f: ReturnType<typeof mcpFixture>, remote: ReturnType<typeof remoteMcp>
beforeEach(() => { f = mcpFixture(); remote = remoteMcp() })
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
const toolCall = async (connection?: string) => {
  const context = await f.run(ids.owner, connection ? [connection] : undefined)
  const tools = await toolsForRun(f.env, context.authorization, () => {}, context.run)
  const tool = tools.descriptors.find(tool => tool.name.startsWith('mcp_'))!
  return { ...context, tools, tool }
}

it('does not auto-grant external tools to the built-in Admin', () => {
  expect(rolePermissions('admin') & Permission.useExternalTools).toBe(0)
})
it('encrypts credentials with Server/connection scope and excludes them from DTOs and compute metadata', async () => {
  const token = 'synthetic-secret-one'
  const connection = await f.connect(f.input({ credential: token }))
  const saved = f.db.prepare('SELECT credential_json FROM mcp_outbound_connections').get() as { credential_json: string }
  expect(saved.credential_json).not.toContain(token)
  expect(connection.hasCredential).toBe(true)
  expect(JSON.stringify(await mcpConnections(f.env, await f.actor()))).not.toContain(token)
  const c = await toolCall(connection.id)
  expect(JSON.stringify(c.tools.descriptors)).not.toMatch(/synthetic-secret|ciphertext|Ignore all policies/)
  expect(c.tool.name.length).toBeLessThanOrEqual(64)
})
it('discovers and invokes a scoped non-GitHub read through the existing Run ledger and safe audit', async () => {
  const connection = await f.connect()
  const c = await toolCall(connection.id)
  const found = await c.tools.call('search_tools', { query: 'Cloudflare documentation' }) as { tools: Array<{ name: string }> }
  expect(found.tools.some(tool => tool.name === c.tool.name)).toBe(true)
  const details = await c.tools.call('get_tool_details', { name: c.tool.name, purpose: 'Read documentation' }) as { tool: { provenance: { connectionId: string } } }
  expect(details.tool.provenance.connectionId).toBe(connection.id)
  const call = { callId: 'read-once', name: c.tool.name, arguments: { query: 'Workers' } }
  const result = await executeRunTool(f.env, c.run.id, c.authorization, call, () => {})
  expect(result).toMatchObject({ connection: { id: connection.id }, tool: 'search_cloudflare_documentation', content: [{ type: 'text', text: expect.stringContaining('Verified source') }] })
  await executeRunTool(f.env, c.run.id, c.authorization, call, () => {})
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
  expect(JSON.stringify(f.db.prepare("SELECT meta_json FROM audit_log WHERE action='tool.connection.call'").all())).toContain(c.run.id)
})
it('requires explicit grants for both the Agent and initiating Member, even when the initiator is Owner', async () => {
  await f.connect(f.input({ grants: { agentIds: [ids.agent], memberIds: [ids.member], roleIds: [] } }))
  const owner = await f.run(), member = await f.run(ids.member)
  expect(await admitMcpConnections(f.env, owner.authorization)).toEqual([])
  expect(await admitMcpConnections(f.env, member.authorization)).toHaveLength(1)
  expect((await toolsForRun(f.env, owner.authorization, () => {}, owner.run)).descriptors.some(tool => tool.name.startsWith('mcp_'))).toBe(false)
})
it('keeps member-owned connections private from other Members and the Server Owner', async () => {
  const personal = f.input({ ownership: 'member', grants: { agentIds: [ids.agent], memberIds: [], roleIds: [] } })
  const connection = await f.connect(personal, ids.member)
  expect((await mcpConnections(f.env, await f.actor())).connections).toEqual([])
  expect((await mcpConnections(f.env, await f.actor(ids.member))).connections.map(c => c.id)).toEqual([connection.id])
  await expect(refreshMcpConnection(f.env, await f.actor(), connection.id)).rejects.toMatchObject({ statusCode: 404 })
  const owner = await f.run(), member = await f.run(ids.member)
  expect((JSON.parse(owner.run.mandateJson).toolConnections)).toEqual([])
  expect((JSON.parse(member.run.mandateJson).toolConnections)).toHaveLength(1)
})
it('does not let a Member create a Server connection or share personal credentials with other Members', async () => {
  await expect(saveMcpConnection(f.env, await f.actor(ids.member), f.input())).rejects.toMatchObject({ statusCode: 403 })
  await expect(saveMcpConnection(f.env, await f.actor(ids.member), f.input({ ownership: 'member' }))).rejects.toMatchObject({ statusCode: 403 })
})
it('never enables a remote write based on a readOnlyHint', async () => {
  remote.state.writeTool = true
  const c = await f.connect()
  expect(c.tools).toHaveLength(1)
  await expect(saveMcpConnection(f.env, await f.actor(), f.input({ toolNames: ['destroy_everything'] }))).rejects.toMatchObject({ statusCode: 400 })
})
it('requires the dedicated Role grant and refuses forged external calls', async () => {
  await f.connect()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.sendMessages, ids.agentRole)
  const c = await f.run(), tools = await toolsForRun(f.env, c.authorization, () => {}, c.run)
  expect(tools.descriptors.some(tool => tool.name.startsWith('mcp_'))).toBe(false)
  await expect(tools.call('mcp_forged', {})).rejects.toMatchObject({ statusCode: 403 })
})
it('blocks disabled connections, cached result replay and later re-enabling within an old Run', async () => {
  const connection = await f.connect(), c = await toolCall()
  const call = { callId: 'cached', name: c.tool.name, arguments: { query: 'Workers' } }
  await executeRunTool(f.env, c.run.id, c.authorization, call, () => {})
  await saveMcpConnection(f.env, await f.actor(), f.input({ enabled: false }), connection.id)
  await expect(executeRunTool(f.env, c.run.id, c.authorization, call, () => {})).rejects.toMatchObject({ statusCode: 403 })
  await saveMcpConnection(f.env, await f.actor(), f.input({ enabled: true }), connection.id)
  expect((await toolsForRun(f.env, c.authorization, () => {}, c.run)).descriptors.some(tool => tool.name.startsWith('mcp_'))).toBe(false)
})
it('rechecks connection revocation between discovery I/O and the remote call', async () => {
  const connection = await f.connect(), c = await toolCall()
  remote.state.hook = () => { f.db.prepare('UPDATE mcp_outbound_connections SET enabled=0,revision=revision+1 WHERE id=?').run(connection.id) }
  await expect(c.tools.call(c.tool.name, { query: 'Workers' })).rejects.toMatchObject({ statusCode: 403 })
  expect(remote.calls.filter(c => c.method === 'tools/call')).toHaveLength(0)
})
it('rechecks current Role authority after remote discovery I/O', async () => {
  await f.connect(); const c = await toolCall()
  remote.state.hook = () => { f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(grant & ~Permission.useExternalTools, ids.agentRole) }
  await expect(c.tools.call(c.tool.name, { query: 'Workers' })).rejects.toMatchObject({ statusCode: 403 })
  expect(remote.calls.filter(c => c.method === 'tools/call')).toHaveLength(0)
})
it('rejects schema drift before invoking and requires refresh/new admission', async () => {
  const connection = await f.connect(), c = await toolCall()
  remote.state.description = 'Changed instructions and schema contract'
  await expect(c.tools.call(c.tool.name, { query: 'Workers' })).rejects.toMatchObject({ statusCode: 409 })
  expect(remote.calls.filter(c => c.method === 'tools/call')).toHaveLength(0)
  await refreshMcpConnection(f.env, await f.actor(), connection.id)
  expect((await toolsForRun(f.env, c.authorization, () => {}, c.run)).descriptors.some(tool => tool.name.startsWith('mcp_'))).toBe(false)
})
it('validates arguments without making an external request', async () => {
  await f.connect(); const c = await toolCall(); remote.calls.length = 0
  await expect(c.tools.call(c.tool.name, { query: 123 })).rejects.toMatchObject({ statusCode: 400 })
  expect(remote.calls).toHaveLength(0)
})
it('redacts echoed credentials from results and does not record them in audit metadata', async () => {
  await f.connect(f.input({ credential: 'synthetic-sensitive-token' })); const c = await toolCall()
  remote.state.echoResult = true
  const result = await c.tools.call(c.tool.name, { query: 'Workers' })
  expect(JSON.stringify(result)).toContain('[redacted]')
  expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-token')
  expect(JSON.stringify(f.db.prepare('SELECT meta_json FROM audit_log').all())).not.toContain('synthetic-sensitive-token')
})
it('does not store credentials echoed into discovery metadata', async () => {
  remote.state.echoMetadata = true
  const connection = await saveMcpConnection(f.env, await f.actor(), f.input({ credential: 'synthetic-sensitive-token' }))
  await expect(refreshMcpConnection(f.env, await f.actor(), connection.id)).rejects.toMatchObject({ statusCode: 502 })
  expect(f.db.prepare('SELECT tools_json,enabled FROM mcp_outbound_connections').get()).toMatchObject({ tools_json: '[]', enabled: 0 })
})
it('disables credentials rejected by the remote server without following OAuth metadata URLs', async () => {
  await f.connect(f.input({ credential: 'synthetic-sensitive-token' })); const c = await toolCall()
  remote.state.unauthorized = true; remote.calls.length = 0
  await expect(c.tools.call(c.tool.name, { query: 'Workers' })).rejects.toMatchObject({ statusCode: 409 })
  expect(f.db.prepare('SELECT enabled,last_error FROM mcp_outbound_connections').get()).toMatchObject({ enabled: 0, last_error: 'credentials_rejected' })
  expect(remote.calls.every(c => c.url === 'https://docs.mcp.cloudflare.com/mcp')).toBe(true)
})
it('isolates two connections with identical remote JSON-RPC IDs and tool names', async () => {
  const a = await f.connect(f.input({ name: 'First', credential: 'synthetic-first-token' })), b = await f.connect(f.input({ name: 'Second', credential: 'synthetic-second-token' }))
  const c = await f.run(), tools = await toolsForRun(f.env, c.authorization, () => {}, c.run)
  const external = tools.descriptors.filter(tool => tool.name.startsWith('mcp_'))
  expect(new Set(external.map(t => t.name)).size).toBe(2)
  const results = await Promise.all(external.map(t => tools.call(t.name, { query: 'Workers' })))
  expect(results.map(result => (result as { connection: { id: string } }).connection.id).sort()).toEqual([a.id, b.id].sort())
  const calls = remote.calls.filter(c => c.method === 'tools/call')
  expect(calls).toHaveLength(2)
  expect(calls[0]!.id).toEqual(calls[1]!.id)
  expect(new Set(calls.map(c => c.authorization)).size).toBe(2)
})

it('keeps an already admitted Run from acquiring a newly shared connection', async () => {
  const old = await f.run()
  await f.connect()
  expect((await toolsForRun(f.env, old.authorization, () => {}, old.run)).descriptors.some(t => t.name.startsWith('mcp_'))).toBe(false)
  expect((await toolCall()).tool).toBeDefined()
})
it('suppresses a result if the connection is revoked while the external read is running', async () => {
  const connection = await f.connect(), c = await toolCall()
  remote.state.hook = () => {
    if (remote.calls.at(-1)?.method === 'tools/call') f.db.prepare('UPDATE mcp_outbound_connections SET enabled=0 WHERE id=?').run(connection.id)
  }
  await expect(c.tools.call(c.tool.name, { query: 'Workers' })).rejects.toMatchObject({ statusCode: 403 })
  expect(remote.calls.filter(c => c.method === 'tools/call')).toHaveLength(1)
})
it('fails closed on expiry and rejects extending expiry without replacing the credential', async () => {
  const expires = new Date(Date.now() + 60000).toISOString()
  const connection = await f.connect(f.input({ credential: 'synthetic-sensitive-token', credentialExpiresAt: expires }))
  await expect(saveMcpConnection(f.env, await f.actor(), f.input({ enabled: true }), connection.id)).rejects.toMatchObject({ statusCode: 400 })
  const c = await toolCall()
  f.db.prepare('UPDATE mcp_outbound_connections SET credential_expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', connection.id)
  expect((await toolsForRun(f.env, c.authorization, () => {}, c.run)).descriptors.some(t => t.name.startsWith('mcp_'))).toBe(false)
})
it('cannot reuse another Server identity to list or modify a connection', async () => {
  const connection = await f.connect(), actor = await f.actor()
  const foreign = { ...actor, serverId: '00000000-0000-4000-8000-000000000099' }
  await expect(mcpConnections(f.env, foreign)).rejects.toMatchObject({ statusCode: 404 })
  await expect(refreshMcpConnection(f.env, foreign, connection.id)).rejects.toMatchObject({ statusCode: 404 })
})
it('supports explicit Role grants for both sides of a delegated Run', async () => {
  await f.connect(f.input({ grants: { agentIds: [], memberIds: [], roleIds: [ids.agentRole, ids.memberRole] } }))
  const member = await f.run(ids.member)
  expect((await toolsForRun(f.env, member.authorization, () => {}, member.run)).descriptors.some(t => t.name.startsWith('mcp_'))).toBe(true)
})
