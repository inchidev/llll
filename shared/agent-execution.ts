import { z } from 'zod'
import type { ResourceAccess } from './resource-access'
import { RESOURCE_KINDS, resourceAccessAllows } from './resource-access'

export function intersectResources(current: ResourceAccess | undefined, cap: ResourceAccess | undefined): ResourceAccess {
  return Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, current?.[kind] == null ? cap?.[kind] ?? null : current[kind]!.filter(id => resourceAccessAllows(cap, kind, id))]))
}

export const runRequestSchema = z.object({
  agentId: z.string().min(8), channelId: z.string().min(8), prompt: z.string().trim().min(1).max(48000),
  environmentId: z.string().min(8).optional(),
  taskId: z.string().min(8).optional(), sourceMessageId: z.string().min(8).optional(),
  idempotencyKey: z.string().min(8).max(200),
})
export type RunRequest = z.infer<typeof runRequestSchema>
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type RunMandate = {
  depth?: number
  environmentId?: string | null
  environmentVersion?: number
  permissions: number
  resourceAccess?: ResourceAccess
  agentPermissions: number
  agentResourceAccess?: ResourceAccess
  computer: boolean
  maxSteps: number
  maxModelCalls: number
  maxToolCalls: number
  maxTokens: number
}
export type AgentRun = {
  id: string; sessionId: string; agentId: string; channelId: string; initiatedBy: string; taskId: string | null
  sourceMessageId: string | null
  status: RunStatus; prompt: string; model: string; instructions: string; mandateJson: string
  environmentJson: string | null; filesKey: string | null
  resultText: string | null; lastError: string | null; modelCalls: number; totalTokens: number
  eventCursor: number; deadline: string; createdAt: string; updatedAt: string
}
export type RuntimeEvent = { type: 'text'; text: string } | { type: 'tool'; name: string }
  | { type: 'result'; text: string; steps: number } | { type: 'error'; message: string }
export type RuntimeTool = { name: string; description: string; parameters: Record<string, unknown> }
