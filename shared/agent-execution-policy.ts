import { z } from 'zod'

/** Admission snapshots these limits. Changing settings cannot expand an existing Run. */
export const agentExecutionPolicySchema = z.object({
  /** The gate on what leaves a box (ADR 0011). role: the Agent publishes its own branch on its own.
   * plan: an approved plan covers the publications that follow it. review: a person approves each push. */
  mode: z.enum(['role', 'plan', 'review']).default('role'),
  maxSteps: z.number().int().min(1).max(2048).default(256),
  maxModelCalls: z.number().int().min(1).max(2048).default(256),
  maxToolCalls: z.number().int().min(1).max(32768).default(4096),
  maxTokens: z.number().int().min(16000).max(20000000).default(2000000),
  maxDurationMs: z.number().int().min(60000).max(86400000).default(21600000),
  dailyTokens: z.number().int().min(16000).max(200000000).default(20000000),
  dailyRuns: z.number().int().min(1).max(10000).default(500),
  repeatedToolCalls: z.number().int().min(2).max(50).default(6),
  maxChildRuns: z.number().int().min(0).max(256).default(64),
  maxDepth: z.number().int().min(1).max(16).default(8),
  /** How long a Task's box may run in all, across its turns. */
  boxRuntimeMs: z.number().int().min(60000).max(86400000).default(21600000),
  /** How many times a Task may publish its branch. */
  publications: z.number().int().min(1).max(1000).default(50),
}).strict()
/** Keys of the per-command Factory that a stored policy may still carry; they are dropped on read. */
export const LEGACY_EXECUTION_POLICY_KEYS = ['workspaceActions', 'workspaceRuntimeMs', 'workspacePublications'] as const
/** A stored policy, with what the per-command Factory left in it ignored rather than refused. */
export function storedExecutionPolicy(value: unknown): AgentExecutionPolicy {
  const legacy = new Set<string>(LEGACY_EXECUTION_POLICY_KEYS)
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !legacy.has(key))) : value
  return agentExecutionPolicySchema.parse(stored)
}
export type AgentExecutionPolicy = z.infer<typeof agentExecutionPolicySchema>
export const defaultAgentExecutionPolicy = (): AgentExecutionPolicy => agentExecutionPolicySchema.parse({})

export type AgentExecutionMode = AgentExecutionPolicy['mode']
/** Outside repository work, plan mode runs like role mode: permissions and Run scope decide. */
export const autonomousExecution = (mode: AgentExecutionMode | undefined): boolean => mode === 'role' || mode === 'plan'
