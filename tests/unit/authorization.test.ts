import { describe, expect, it } from 'vitest'
import { authorize, AuthorizationError, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { Permission } from '../../shared/permissions'

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    serverId: 'main',
    principal: { id: 'agent-1', kind: 'agent', roleId: 'role-1', roleName: 'Agent', permissions: Permission.manageTasks, isOwner: false },
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

  it('uses the invoking human authority for bounded Agent tools', () => {
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
    expect(() => authorize(delegated, ServerAction.readTasks)).not.toThrow()
    expect(() => authorize(delegated, ServerAction.writeTasks)).not.toThrow()
    expect(() => authorize(delegated, ServerAction.writeDocuments)).toThrow(AuthorizationError)
  })
})
