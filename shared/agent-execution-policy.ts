import { z } from 'zod'

/** Admission snapshots these limits. Changing settings cannot expand an existing Run. */
export const agentExecutionPolicySchema = z.object({
  /** role: autonomous within permissions. plan: autonomous after the person approves the Agent's plan
   * for repository work; publication still waits. review: every workspace operation waits. */
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
  workspaceActions: z.number().int().min(10).max(32768).default(2000),
  workspaceRuntimeMs: z.number().int().min(60000).max(86400000).default(21600000),
  workspacePublications: z.number().int().min(1).max(1000).default(50),
}).strict()
export type AgentExecutionPolicy = z.infer<typeof agentExecutionPolicySchema>
export const defaultAgentExecutionPolicy = (): AgentExecutionPolicy => agentExecutionPolicySchema.parse({})

export type AgentExecutionMode = AgentExecutionPolicy['mode']
/** Outside repository work, plan mode runs like role mode: permissions and Run scope decide. */
export const autonomousExecution = (mode: AgentExecutionMode | undefined): boolean => mode === 'role' || mode === 'plan'
