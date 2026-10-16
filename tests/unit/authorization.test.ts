import { describe, expect, it } from 'vitest'
import { authorize, AuthorizationError, WorkspaceAction, type AuthorizationContext } from '../../shared/authorization'
import { Permission } from '../../shared/permissions'

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    workspaceId: 'main',
    principal: { id: 'agent-1', kind: 'agent', roleId: 'role-1', roleName: 'Agent', permissions: Permission.manageTasks, isOwner: false },
    credential: { kind: 'mcp', id: 'token-1', scopes: ['tasks:read'] },
    ...overrides,
  }
}

describe('workspace authorization', () => {
  it('intersects current role, credential scope, and delegation', () => {
    const allowed = context({ delegation: { by: 'human-1', actions: [WorkspaceAction.readTasks] } })
    expect(() => authorize(allowed, WorkspaceAction.readTasks)).not.toThrow()
    expect(() => authorize(allowed, WorkspaceAction.writeTasks)).toThrow(AuthorizationError)

    const missingScope = context({ credential: { kind: 'mcp', scopes: ['documents:read'] } })
    expect(() => authorize(missingScope, WorkspaceAction.readTasks)).toThrow('tasks:read scope')

    const missingRole = context({ principal: { ...context().principal, permissions: 0 } })
    expect(() => authorize(missingRole, WorkspaceAction.readTasks)).toThrow('Agent role')
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
        actions: [WorkspaceAction.readTasks, WorkspaceAction.writeTasks],
      },
    })
    expect(() => authorize(delegated, WorkspaceAction.readTasks)).not.toThrow()
    expect(() => authorize(delegated, WorkspaceAction.writeTasks)).not.toThrow()
    expect(() => authorize(delegated, WorkspaceAction.writeDocuments)).toThrow(AuthorizationError)
  })
})
