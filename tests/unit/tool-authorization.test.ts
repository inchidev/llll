import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { McpScope } from '../../shared/mcp'
import { authorizeToolCall, TOOL_RULES, toolActions, toolRule } from '../../server/utils/tool-authorization'

const SERVER = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-0000000000a1'
type Options = { agent?: number; person?: number; scopes?: McpScope[] | null; credential?: AuthorizationContext['credential']['kind']; kind?: 'human' | 'agent'; policies?: AuthorizationContext['principal']['projectPolicies']; personPolicies?: AuthorizationContext['principal']['projectPolicies'] }
/** An Agent acting for a person, as a Run or an MCP credential loads it. */
function context({ agent = ALL_PERMISSIONS, person, scopes = null, credential = 'agent_runtime', kind = 'agent', policies = [], personPolicies = [] }: Options = {}): AuthorizationContext {
  return {
    serverId: SERVER,
    spaces: { ids: [SALES], active: SALES, denied: { boards: new Set(['board-hr']), databases: new Set(['db-hr']) } },
    principal: { id: 'mike', kind, roleId: 'agent-role', roleName: 'Researcher', permissions: agent, isOwner: false, resourceAccess: {}, projectPolicies: policies },
    credential: credential === 'mcp' ? { kind: 'mcp', id: 'token', scopes: scopes ?? [] } : { kind: credential },
    ...(person === undefined ? {} : { delegation: { by: 'petya', permissions: person, isOwner: false, roleName: 'Member', resourceAccess: {}, projectPolicies: personPolicies } }),
  }
}
const refusal = (auth: AuthorizationContext, name: string) => { try { authorizeToolCall(auth, name); return null } catch (error) { return error as Error & { statusCode: number } } }

describe('one authorization point for tool calls', () => {
  it('refuses a tool it does not know, and knows every built-in tool by its action', () => {
    expect(refusal(context(), 'drop_everything')).toMatchObject({ statusCode: 403, message: 'drop_everything is not a Server tool, so it cannot be used' })
    expect(toolRule('mcp_abc_search')).toEqual({ actions: ['tools:read'] })
    expect(toolActions('create_task')).toEqual(['tasks:write'])
    expect(toolActions('get_item')).toEqual(['documents:read', 'data:read'])
    expect(Object.keys(TOOL_RULES).length).toBeGreaterThan(60)
  })

  it('stops at the Agent’s own Role', () => {
    const auth = context({ agent: Permission.readTasks, person: ALL_PERMISSIONS })
    expect(refusal(auth, 'list_tasks')).toBeNull()
    expect(refusal(auth, 'create_task')).toMatchObject({ statusCode: 403, message: 'create_task is not available: The Researcher role cannot perform tasks:write' })
  })

  it('stops at the person the Agent acts for, whatever the Agent may do', () => {
    const petya = context({ person: Permission.readTasks | Permission.sendMessages })
    expect(refusal(petya, 'get_task')).toBeNull()
    expect(refusal(petya, 'create_task')).toMatchObject({ statusCode: 403, message: 'create_task is not available: The delegating Member cannot perform tasks:write' })
    expect(refusal(petya, 'read_records')).toMatchObject({ statusCode: 403 })
    expect(refusal(petya, 'search_web')).toMatchObject({ statusCode: 403 })
    expect(refusal(petya, 'mcp_abc_search')).toMatchObject({ statusCode: 403, message: expect.stringContaining('tools:read') })
    const vanya = context({ person: Permission.readTasks | Permission.writeTasks })
    expect(refusal(vanya, 'create_task')).toBeNull()
  })

  it('needs one of the actions a tool may stand for, then leaves the exact kind to the service', () => {
    const documents = context({ person: Permission.readData })
    expect(refusal(documents, 'get_item')).toBeNull()
    expect(refusal(documents, 'search_data')).toBeNull()
    const nothing = context({ person: Permission.sendMessages })
    expect(refusal(nothing, 'get_item')).toMatchObject({ statusCode: 403, message: expect.stringContaining('get_item is not available') })
    expect(refusal(nothing, 'search_data')).toMatchObject({ statusCode: 403 })
    expect(refusal(nothing, 'create_item')).toMatchObject({ statusCode: 403 })
  })

  it('applies an MCP credential’s scopes on top of both Roles', () => {
    const mcp = (scopes: McpScope[]) => context({ person: ALL_PERMISSIONS, credential: 'mcp', scopes })
    expect(refusal(mcp(['tasks:read']), 'list_task_boards')).toBeNull()
    expect(refusal(mcp(['messages:read']), 'list_task_boards')).toMatchObject({ statusCode: 403, message: 'list_task_boards is not available: Access token is missing the tasks:read scope' })
    expect(refusal(mcp(['messages:read']), 'send_message')).toMatchObject({ statusCode: 403, message: expect.stringContaining('messages:write scope') })
    expect(refusal(mcp(['messages:write']), 'send_message')).toBeNull()
    expect(refusal(mcp(['mail:read']), 'move_mail_thread')).toMatchObject({ statusCode: 403 })
    // Connecting at all needs the permission, as for any MCP client.
    expect(refusal(context({ agent: ALL_PERMISSIONS & ~Permission.mcpConnect, credential: 'mcp', scopes: ['tasks:read'] }), 'list_tasks')).toMatchObject({ statusCode: 403, message: expect.stringContaining('mcp.connect') })
  })

  it('counts a Project policy for Task tools as the interface does, within the credential’s scopes', () => {
    const policy = [{ id: 'g1', projectId: 'project-a', policyId: 'developer', policyVersion: 1, permissions: Permission.readTasks | Permission.writeTasks }]
    const member = context({ agent: Permission.readTasks | Permission.writeTasks | Permission.mcpConnect, person: Permission.sendMessages, policies: policy, personPolicies: policy })
    expect(refusal(member, 'create_task')).toBeNull()
    expect(refusal(member, 'list_tasks')).toBeNull()
    expect(refusal({ ...member, credential: { kind: 'mcp', id: 't', scopes: ['tasks:read'] } }, 'create_task')).toMatchObject({ statusCode: 403, message: expect.stringContaining('tasks:write scope') })
    // The policy covers Tasks only; nothing else of the Role follows.
    expect(refusal(member, 'read_records')).toMatchObject({ statusCode: 403 })
    // A policy the Agent holds but the person does not grants nothing.
    expect(refusal(context({ agent: Permission.writeTasks, person: Permission.sendMessages, policies: policy }), 'create_task')).toMatchObject({ statusCode: 403 })
  })

  it('reserves complete_run for an Agent', () => {
    expect(refusal(context({ kind: 'human', credential: 'mcp', scopes: ['messages:write'] }), 'complete_run')).toMatchObject({ statusCode: 403, message: 'complete_run is not available: Only an Agent can call it' })
    expect(refusal(context({ credential: 'mcp', scopes: ['messages:write'] }), 'complete_run')).toBeNull()
  })

  it('answers Not found for a resource in another Space, before any permission', () => {
    const auth = context({ person: ALL_PERMISSIONS })
    expect(() => authorizeToolCall(auth, 'read_records', { kind: 'databases', id: 'db-sales' })).not.toThrow()
    expect(() => authorizeToolCall(auth, 'read_records', { kind: 'databases', id: 'db-hr' })).toThrow(expect.objectContaining({ statusCode: 404, message: 'Not found' }))
    expect(() => authorizeToolCall(auth, 'create_task', { kind: 'boards', id: 'board-hr' })).toThrow(expect.objectContaining({ statusCode: 404 }))
  })
})
