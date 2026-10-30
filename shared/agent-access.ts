import { z } from 'zod'
import type { ProjectPolicyGrant } from './project-access'

/** open: anyone who may use Agents invokes it. granted: only the Owner and holders of Agent access. */
export const AgentAccessModes = ['open', 'granted'] as const
export type AgentAccessMode = typeof AgentAccessModes[number]

const id = z.string().min(1).max(200)
export const agentAccessSchema = z.object({
  policyId: id,
  memberId: id.nullable().default(null),
  roleId: id.nullable().default(null),
  /** null: everywhere on this Server, within the subject's own resource scope. */
  projectId: id.nullable().default(null),
  dailyRuns: z.number().int().min(1).max(10000).nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
}).strict().refine(value => Boolean(value.memberId) !== Boolean(value.roleId), 'Choose one member or one role')
export type AgentAccessInput = z.input<typeof agentAccessSchema>

export const agentAccessModeSchema = z.object({ access: z.enum(AgentAccessModes) }).strict()

export type AgentAccessGrant = {
  id: string
  agentId: string
  policyId: string
  policyName: string
  permissions: number
  memberId: string | null
  roleId: string | null
  /** The member's or role's display name. */
  name: string
  kind: string
  projectId: string | null
  projectName: string | null
  dailyRuns: number | null
  expiresAt: string | null
  createdAt: string
}

export type AgentAccessDTO = { access: AgentAccessMode; grants: AgentAccessGrant[]; canManage: boolean }

/** What one person may do through one Agent, beyond their own Role. */
export type DelegatedAgentAccess = {
  /** Number of current grants; a granted-access Agent needs at least one. */
  grants: number
  /** Server-wide permissions the grants add. */
  permissions: number
  /** Project-scoped grants, kept separate per Project like project assignments. */
  projectPolicies: ProjectPolicyGrant[]
  /** The tightest daily Run limit among the grants, if any sets one. */
  dailyRuns: number | null
}
