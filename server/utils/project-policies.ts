import type { AuthorizationContext } from '../../shared/authorization'
import { hasPermission, Permission, PermissionGrants } from '../../shared/permissions'
import { projectAssignmentSchema, projectAssignmentPatchSchema, projectPolicySchema, projectPolicyPatchSchema, ProjectPolicyPermissions, projectPermissionAllowed, type ProjectAssignment, type ProjectPolicy, type ProjectPolicyGrant } from '../../shared/project-access'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { writeAudit } from './messages'

export async function loadProjectPolicies(env: L4Env, memberId: string, roleId: string): Promise<ProjectPolicyGrant[]> {
  const rows = await env.DB.prepare(`SELECT a.id,a.project_id AS projectId,p.id AS policyId,p.version AS policyVersion,p.permissions_bitmask AS permissions
    FROM project_policy_assignments a JOIN project_policies p ON p.id=a.policy_id JOIN projects j ON j.id=a.project_id
    WHERE (a.member_id=? OR a.role_id=?) AND j.archived_at IS NULL ORDER BY a.id`).bind(memberId, roleId).all<ProjectPolicyGrant>()
  return rows.results
}

/** Load the same grants for a member list without a query per member. */
export async function loadMemberProjectPolicies(env: L4Env, members: Array<{ id: string; roleId: string }>): Promise<Map<string, ProjectPolicyGrant[]>> {
  const result = new Map<string, ProjectPolicyGrant[]>()
  if (!members.length) return result
  const rows = await env.DB.prepare(`SELECT a.id,a.project_id AS projectId,p.id AS policyId,p.version AS policyVersion,p.permissions_bitmask AS permissions,
      a.member_id AS memberId,a.role_id AS roleId
    FROM project_policy_assignments a JOIN project_policies p ON p.id=a.policy_id JOIN projects j ON j.id=a.project_id
    WHERE j.archived_at IS NULL ORDER BY a.id`).all<ProjectPolicyGrant & { memberId: string | null; roleId: string | null }>()
  const byMember = new Map<string, ProjectPolicyGrant[]>()
  const byRole = new Map<string, ProjectPolicyGrant[]>()
  for (const { memberId, roleId, ...grant } of rows.results) {
    const target = memberId ? byMember : byRole
    const key = (memberId ?? roleId)!
    const grants = target.get(key) ?? []
    grants.push(grant)
    target.set(key, grants)
  }
  for (const member of members) {
    const direct = byMember.get(member.id) ?? [], role = byRole.get(member.roleId) ?? []
    const grants: ProjectPolicyGrant[] = []
    let i = 0, j = 0
    while (i < direct.length && j < role.length) grants.push(direct[i]!.id < role[j]!.id ? direct[i++]! : role[j++]!)
    grants.push(...direct.slice(i), ...role.slice(j))
    result.set(member.id, grants)
  }
  return result
}
export function requirePolicyManager(auth: AuthorizationContext) {
  if (auth.principal.kind !== 'human' || auth.credential.kind !== 'session' || auth.delegation
    || (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.manageRoles))) fail(403, 'policy_denied', 'Manage roles with a human session is required')
}
function assertPolicyGrant(auth: AuthorizationContext, permissions: number, projectId?: string) {
  if (auth.principal.isOwner) return
  for (const grant of PermissionGrants) if ((permissions & grant.flag) && !(projectId
    ? projectPermissionAllowed(auth, projectId, grant.flag)
    : hasPermission(auth.principal.permissions, grant.flag))) fail(403, 'policy_denied', 'Cannot grant project permissions you do not have')
}
export async function listProjectPolicies(env: L4Env) {
  return (await env.DB.prepare('SELECT id,name,description,permissions_bitmask AS permissions,version FROM project_policies ORDER BY name,id').all<ProjectPolicy>()).results
}
export async function saveProjectPolicy(env: L4Env, auth: AuthorizationContext, request: unknown, id?: string) {
  requirePolicyManager(auth)
  const input = id ? projectPolicyPatchSchema.parse(request) : projectPolicySchema.parse(request)
  assertPolicyGrant(auth, input.permissions)
  const policyId = id ?? newId()
  if (id) {
    if (id === 'server-policy-owner' || id === 'server-policy-admin' || id === 'server-policy-member') fail(403, 'policy_denied', 'System policies cannot be changed')
    const previous = await env.DB.prepare('SELECT permissions_bitmask AS permissions FROM project_policies WHERE id=?').bind(id).first<{ permissions: number }>()
    if (!previous) fail(404, 'not_found', 'Policy not found')
    assertPolicyGrant(auth, previous.permissions)
    const roleAssignment = await env.DB.prepare('SELECT role_id FROM role_policies WHERE policy_id=? LIMIT 1').bind(id).first()
    if (roleAssignment && !auth.principal.isOwner) fail(403, 'policy_denied', 'Only the owner can edit a policy assigned to a role')
    if ((input.permissions & ~ProjectPolicyPermissions) !== 0) {
      const projectAssignment = await env.DB.prepare('SELECT id FROM project_policy_assignments WHERE policy_id=? LIMIT 1').bind(id).first()
      if (projectAssignment) fail(400, 'policy_scope', 'Policies assigned in projects cannot include server permissions')
    }
    // Editing a reusable policy affects every assignment. A scoped manager may
    // not use a definition edit to expand another project's authority.
    if (!auth.principal.isOwner) {
      const targets = await env.DB.prepare('SELECT DISTINCT project_id AS id FROM project_policy_assignments WHERE policy_id=?').bind(id).all<{ id: string }>()
      for (const target of targets.results) {
        if (!projectPermissionAllowed(auth, target.id, Permission.manageProjects)) fail(403, 'policy_denied', 'Manage every affected project before editing a shared policy')
        assertPolicyGrant(auth, input.permissions, target.id)
      }
    }
    const changed = await env.DB.prepare('UPDATE project_policies SET name=?,description=?,permissions_bitmask=?,version=version+1,updated_at=? WHERE id=? AND version=? RETURNING id')
      .bind(input.name, input.description, input.permissions, nowIso(), id, 'version' in input ? input.version : 0).first()
    if (!changed) fail(409, 'policy_changed', 'Policy changed; reload before saving')
  } else await env.DB.prepare('INSERT INTO project_policies(id,name,description,permissions_bitmask,created_by) VALUES(?,?,?,?,?)')
    .bind(policyId, input.name, input.description, input.permissions, auth.principal.id).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: id ? 'policy.update' : 'policy.create', targetType: 'policy', targetId: policyId, authorization: auth })
  return (await listProjectPolicies(env)).find(policy => policy.id === policyId)!
}
async function assignmentAuthority(env: L4Env, auth: AuthorizationContext, projectId: string) {
  requirePolicyManager(auth)
  if (!projectPermissionAllowed(auth, projectId, Permission.manageProjects)) fail(403, 'policy_denied', 'Manage this project before changing access')
  const project = await env.DB.prepare('SELECT archived_at AS archivedAt FROM projects WHERE id=?').bind(projectId).first<{ archivedAt: string | null }>()
  if (!project) fail(404, 'not_found', 'Project not found')
  if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before changing access')
}
export async function listProjectAssignments(env: L4Env, projectId: string) {
  return (await env.DB.prepare(`SELECT a.id,a.project_id AS projectId,a.policy_id AS policyId,a.member_id AS memberId,a.role_id AS roleId,
    coalesce(u.display_name,r.name) AS name,coalesce(u.kind,'role') AS kind,p.name AS policyName,p.permissions_bitmask AS permissions
    FROM project_policy_assignments a JOIN project_policies p ON p.id=a.policy_id LEFT JOIN users u ON u.id=a.member_id LEFT JOIN roles r ON r.id=a.role_id WHERE a.project_id=? ORDER BY name,p.name,a.id`)
    .bind(projectId).all<ProjectAssignment>()).results
}
export async function assignProjectPolicy(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  await assignmentAuthority(env, auth, projectId)
  const input = projectAssignmentSchema.parse(request), policy = (await listProjectPolicies(env)).find(p => p.id === input.policyId)
  if (!policy) fail(404, 'not_found', 'Policy not found')
  if ((policy.permissions & ~ProjectPolicyPermissions) !== 0) fail(400, 'policy_scope', 'This policy includes server permissions and cannot be assigned within a project')
  assertPolicyGrant(auth, policy.permissions, projectId)
  const target = input.memberId
    ? await env.DB.prepare("SELECT id FROM users WHERE id=? AND status='active'").bind(input.memberId).first()
    : await env.DB.prepare("SELECT id FROM roles WHERE id=? AND key<>'owner'").bind(input.roleId).first()
  if (!target) fail(400, 'policy_target', 'Choose an active member or a non-owner role')
  const id = newId()
  const inserted = await env.DB.prepare('INSERT INTO project_policy_assignments(id,project_id,policy_id,member_id,role_id,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id')
    .bind(id, projectId, input.policyId, input.memberId, input.roleId, auth.principal.id, nowIso()).first()
  if (!inserted) fail(409, 'policy_exists', 'This access is already assigned')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.access.assign', targetType: 'project', targetId: projectId, meta: { assignmentId: id, policyId: policy.id }, authorization: auth })
  return (await listProjectAssignments(env, projectId)).find(a => a.id === id)!
}
export async function revokeProjectPolicy(env: L4Env, auth: AuthorizationContext, projectId: string, id: string) {
  await assignmentAuthority(env, auth, projectId)
  const current = (await listProjectAssignments(env, projectId)).find(a => a.id === id)
  if (!current) fail(404, 'not_found', 'Assignment not found')
  assertPolicyGrant(auth, current.permissions, projectId)
  await env.DB.prepare('DELETE FROM project_policy_assignments WHERE id=? AND project_id=?').bind(id, projectId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.access.revoke', targetType: 'project', targetId: projectId, meta: { assignmentId: id }, authorization: auth })
}
export async function replaceProjectPolicy(env: L4Env, auth: AuthorizationContext, projectId: string, id: string, request: unknown) {
  await assignmentAuthority(env, auth, projectId)
  const current = (await listProjectAssignments(env, projectId)).find(a => a.id === id)
  if (!current) fail(404, 'not_found', 'Assignment not found')
  const input = projectAssignmentPatchSchema.parse(request), policy = (await listProjectPolicies(env)).find(p => p.id === input.policyId)
  if (!policy) fail(404, 'not_found', 'Policy not found')
  if ((policy.permissions & ~ProjectPolicyPermissions) !== 0) fail(400, 'policy_scope', 'This policy includes server permissions and cannot be assigned within a project')
  assertPolicyGrant(auth, current.permissions, projectId); assertPolicyGrant(auth, policy.permissions, projectId)
  if (policy.id === current.policyId) return current
  // A replacement gets a fresh identity. Changing A -> B -> A must not revive
  // a Run whose original assignment was revoked in between.
  const replacementId = newId()
  const changed = await env.DB.prepare('UPDATE project_policy_assignments SET id=?,policy_id=? WHERE id=? AND project_id=? RETURNING id').bind(replacementId, policy.id, id, projectId).first()
  if (!changed) fail(409, 'policy_changed', 'Project access changed; reload before saving')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.access.update', targetType: 'project', targetId: projectId, meta: { assignmentId: replacementId, previousAssignmentId: id, policyId: policy.id }, authorization: auth })
  return (await listProjectAssignments(env, projectId)).find(a => a.id === replacementId)!
}
