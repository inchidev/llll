import { expect, it } from 'vitest'
import { agentRoleSummary, TaskAgentPermissions } from '../../shared/agent-roles'
import { hasPermission, Permission, rolePermissions } from '../../shared/permissions'

it('keeps built-in Admin and Member roles out of autonomous task execution', () => {
  expect(agentRoleSummary({ permissions: rolePermissions('admin') })).toContain('Execute assigned tasks')
  expect(agentRoleSummary({ permissions: rolePermissions('member') })).toContain('Read tasks')
  expect(hasPermission(rolePermissions('admin'), Permission.executeTasks)).toBe(false)
})
it('offers a task role without administrative, computer or unrelated permissions', () => {
  expect(agentRoleSummary({ permissions: TaskAgentPermissions })).toMatch(/^Can execute/)
  expect(TaskAgentPermissions).toBe(Permission.readTasks | Permission.writeTasks | Permission.executeTasks | Permission.sendMessages)
  expect(hasPermission(TaskAgentPermissions, Permission.manageRoles)).toBe(false)
  expect(hasPermission(TaskAgentPermissions, Permission.useComputer)).toBe(false)
})
it('recognizes task-management aliases but still requires reporting permission', () => {
  expect(agentRoleSummary({ permissions: Permission.manageTasks | Permission.executeTasks | Permission.sendMessages })).toMatch(/^Can execute/)
  expect(agentRoleSummary({ permissions: Permission.readTasks | Permission.executeTasks })).toContain('Send messages')
})
