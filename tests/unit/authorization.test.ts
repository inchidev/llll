import { describe, expect, it } from 'vitest'
import { authorize, AuthorizationError, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { Permission } from '../../shared/permissions'

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    serverId: 'main',
    principal: { id: 'agent-1', kind: 'agent', roleId: 'role-1', roleName: 'Agent', permissions: Permission.manageTasks | Permission.mcpConnect, isOwner: false },
    credential: { kind: 'mcp', id: 'token-1', scopes: ['tasks:read'] },
    ...overrides,
  }
}

describe('server authorization', () => {
  it('intersects current role, credential scope, and delegation', () => {
    const allowed = context({ delegation: { by: 'human-1', actions: [ServerAction.readTasks] } })
    expect(() => authorize(allowed, ServerAction.readTasks)).not.toThrow()
    expect(() => authorize(allowed, ServerAction.writeTasks)).toThrow(AuthorizationError)

    const missingScope = context({ credential: { kind: 'mcp', scopes: ['documents:read'] } })
    expect(() => authorize(missingScope, ServerAction.readTasks)).toThrow('tasks:read scope')

    const missingRole = context({ principal: { ...context().principal, permissions: 0 } })
    expect(() => authorize(missingRole, ServerAction.readTasks)).toThrow('Agent role')
  })

  it('never elevates an Agent to the invoking owner authority', () => {
    const delegated = context({
      principal: { ...context().principal, permissions: Permission.sendMessages, roleName: 'Member' },
      credential: { kind: 'agent_runtime', id: 'channel-general' },
      delegation: {
        by: 'owner-1',
        permissions: 0,
        isOwner: true,
        roleName: 'Owner',
        actions: [ServerAction.readTasks, ServerAction.writeTasks],
      },
    })
    expect(() => authorize(delegated, ServerAction.readTasks)).toThrow('Member role')
    expect(() => authorize(delegated, ServerAction.writeTasks)).toThrow('Member role')
    expect(() => authorize(delegated, ServerAction.writeDocuments)).toThrow(AuthorizationError)
  })

  it('requires mcp.connect for MCP credentials without affecting browser or internal Agent access', () => {
    const member = { ...context().principal, permissions: Permission.manageTasks }
    expect(() => authorize(context({ principal: member }), ServerAction.readTasks)).toThrow('mcp.connect')
    for (const kind of ['session', 'agent_runtime'] as const) {
      expect(() => authorize(context({ principal: member, credential: { kind } }), ServerAction.readTasks)).not.toThrow()
    }
  })
})

describe('bounded agent permissions', () => {
  it('requires both the agent and the delegator to have the operation', () => {
    const delegated = context({ credential: { kind: 'agent_runtime' }, delegation: { by: 'human', permissions: Permission.readTasks } })
    expect(() => authorize(delegated, ServerAction.readTasks)).not.toThrow()
    expect(() => authorize(delegated, ServerAction.writeTasks)).toThrow('delegating')
  })

  it('allows read-only roles without granting task mutation or administration', () => {
    const reader = context({ principal: { ...context().principal, permissions: Permission.readTasks }, credential: { kind: 'session' } })
    expect(() => authorize(reader, ServerAction.readTasks)).not.toThrow()
    expect(() => authorize(reader, ServerAction.writeTasks)).toThrow()
  })
})
