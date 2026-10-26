import { hasPermission, Permission } from './permissions'
import type { RoleDTO } from './types'

export const TaskAgentPermissions = Permission.readTasks | Permission.writeTasks | Permission.executeTasks | Permission.sendMessages

export const FactoryAgentPermissions = Permission.readProjects | Permission.readTasks | Permission.executeTasks | Permission.sendMessages | Permission.useComputer | Permission.proposeCode

export const TaskAgentGrants = [
  { flag: Permission.readTasks, label: 'Read tasks' },
  { flag: Permission.writeTasks, label: 'Create and update tasks' },
  { flag: Permission.executeTasks, label: 'Execute assigned tasks' },
  { flag: Permission.sendMessages, label: 'Send messages' },
] as const

export function agentRoleSummary(role: Pick<RoleDTO, 'permissions'>): string {
  const missing = TaskAgentGrants.filter(grant => grant.flag !== Permission.writeTasks && !hasPermission(role.permissions, grant.flag))
  return missing.length
    ? 'Assigned tasks need: ' + missing.map(grant => grant.label).join(', ') + '.'
    : 'Can execute assigned tasks and report in channels it can access.'
}
