export type AgentAuditRun = { kind: 'run'; id: string; createdAt: string; agentName: string; initiatedBy: string; initiatorName: string; status: string; lastError?: string | null; model: string; modelCalls: number; totalTokens: number; toolCalls: number }
export type AgentAuditChange = { kind: 'change'; id: string; createdAt: string; actorName: string; action: string; targetType: string; targetId: string; model?: string | null; status?: string | null; error?: string | null; totalTokens?: number | null }
export type AgentAuditRow = AgentAuditRun | AgentAuditChange
export type AgentAuditPage = { entries: AgentAuditRow[]; total: number }
