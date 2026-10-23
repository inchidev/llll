export type AgentAuditRun = { kind: 'run'; id: string; createdAt: string; agentName: string; initiatorName: string; status: string; lastError?: string | null; model: string; modelCalls: number; totalTokens: number; toolCalls: number }
export type AgentAuditChange = { kind: 'change'; id: string; createdAt: string; actorName: string; action: string; targetType: string; targetId: string }
export type AgentAuditRow = AgentAuditRun | AgentAuditChange
export type AgentAuditPage = { entries: AgentAuditRow[]; total: number }
