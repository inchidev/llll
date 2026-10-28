import { z } from 'zod'
import { ALL_PERMISSIONS, hasPermission, Permission, PermissionGrants, type PermissionFlag } from './permissions'
import { resourceAccessAllows, type ResourceKind } from './resource-access'
import type { AuthorizationContext } from './authorization'

export const ProjectPolicyPermissions = Permission.readProjects | Permission.readTasks | Permission.writeTasks
  | Permission.executeTasks | Permission.useComputer | Permission.proposeCode | Permission.browseWeb
  | Permission.useAgents | Permission.approveAgentActions | Permission.delegateTasks
export const ProjectPolicyGrants = PermissionGrants.filter(grant => (ProjectPolicyPermissions & grant.flag) === grant.flag)
export const projectPolicySchema = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(2000).default(''),
  permissions: z.number().int().min(0).max(ALL_PERMISSIONS).refine(value => (value & ~ALL_PERMISSIONS) === 0, 'Unknown permissions'),
}).strict()
export const projectPolicyPatchSchema = projectPolicySchema.extend({ version: z.number().int().positive() })
export const projectAssignmentSchema = z.object({ policyId: z.string().min(1).max(200), memberId: z.string().min(1).max(200).nullable().default(null), roleId: z.string().min(1).max(200).nullable().default(null) })
  .strict().refine(value => Boolean(value.memberId) !== Boolean(value.roleId), 'Choose one member or one role')
export const projectAssignmentPatchSchema = z.object({ policyId: z.string().min(1).max(200) }).strict()
export type ProjectPolicy = { id: string; name: string; description: string; permissions: number; version: number }
export type ProjectPolicyGrant = { id: string; projectId: string; policyId: string; policyVersion: number; permissions: number }
export type ProjectAssignment = { id: string; projectId: string; policyId: string; memberId: string | null; roleId: string | null; name: string; kind: string; policyName: string; permissions: number }
export type ProjectPermissionResource = { kind: ResourceKind; id: string }
export function projectSubjectPermissionAllowed(subject: AuthorizationContext['principal'] | NonNullable<AuthorizationContext['delegation']>, projectId: string, flag: PermissionFlag, resource?: ProjectPermissionResource): boolean {
  return Boolean(subject.isOwner)
    || (hasPermission(subject.permissions ?? 0, flag) && resourceAccessAllows(subject.resourceAccess, 'projects', projectId)
      && (!resource || resourceAccessAllows(subject.resourceAccess, resource.kind, resource.id)))
    || Boolean((ProjectPolicyPermissions & flag) === flag && subject.projectPolicies?.some(grant => grant.projectId === projectId && hasPermission(grant.permissions, flag)))
}

/** Each permission stays attached to its project. Never union project IDs and
 * permission masks independently: that creates cross-project authority. */
export function projectPermissionAllowed(auth: AuthorizationContext, projectId: string, flag: PermissionFlag, resource?: ProjectPermissionResource): boolean {
  if (auth.projectScope && auth.projectScope.id !== projectId) return false
  return projectSubjectPermissionAllowed(auth.principal, projectId, flag, resource)
    && (!auth.delegation || projectSubjectPermissionAllowed(auth.delegation, projectId, flag, resource))
}
export function anyProjectPermission(auth: AuthorizationContext, flag: PermissionFlag): boolean {
  const candidates = new Set((auth.principal.projectPolicies ?? []).map(grant => grant.projectId))
  return [...candidates].some(id => projectPermissionAllowed(auth, id, flag))
}

/**
 * Whether a Member's directory includes Agents. HTTP members and MCP `list_members`
 * share this rule: the Owner, Use agents or Manage agents, globally or in a project.
 */
export function canViewAgentMembers(auth: AuthorizationContext): boolean {
  const { principal } = auth
  return principal.isOwner || hasPermission(principal.permissions, Permission.useAgents)
    || hasPermission(principal.permissions, Permission.manageAgents) || anyProjectPermission(auth, Permission.useAgents)
}
