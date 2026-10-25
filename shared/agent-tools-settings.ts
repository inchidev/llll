import type { DiscoverableTool } from './tool-discovery'
export type ToolOption = { id: string; name: string }
export type ToolAgentOption = ToolOption & { roleId: string; status: string }
export type ToolsSettingsDTO = {
  agents: ToolAgentOption[]; members: ToolOption[]; roles: ToolOption[]
  mayConnect: boolean; mayManageServer: boolean; mayPreview: boolean; mayAudit: boolean
  capabilities: Array<{ name: string; available: boolean; detail: string }>
  preview?: { agentId: string; tools: DiscoverableTool[]; diagnostics: string[] }
}
export type ToolAuditEntry = { id: string; createdAt: string; action: string; actorName: string; connectionId: string; runId: string | null; taskId: string | null; discussionId: string | null; tool: string | null; status: string | null; schemaHash: string | null }
export type ToolAuditPage = { entries: ToolAuditEntry[]; total: number }
