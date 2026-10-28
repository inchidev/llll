import type { PermissionGrantKey } from './permissions'
import type { ServerNavigationSection } from './server-navigation'
import type { McpScope } from './mcp'

/**
 * Product areas paused while L4 focuses on chat, mail, projects, tasks, schedules, agents and code work.
 * Only their entry points are hidden: the Client navigation and routes, their Role grants,
 * and the agent and MCP tools. Stored data, HTTP APIs and existing grants stay intact, so
 * turning an area back on is a matter of removing it from these lists.
 */
export const pausedSections: ReadonlySet<ServerNavigationSection> = new Set(['data', 'gadgets'])

export const pausedPermissionKeys: ReadonlySet<PermissionGrantKey> = new Set([
  'readData', 'writeData', 'manageDatabases', 'useGadgets', 'manageGadgets',
])

export const pausedMcpScopes: ReadonlySet<McpScope> = new Set(['data:manage', 'data:read', 'data:write', 'documents:read', 'documents:write'])

const pausedTools = new Set([
  // Data: tables, records and documents.
  'list_data', 'list_tables', 'create_table', 'read_records', 'create_record', 'update_record',
  'list_documents', 'get_document', 'create_document', 'update_document',
])

/** Agent and MCP tools of a paused area are neither discoverable nor callable. */
export function toolPaused(name: string): boolean {
  return pausedTools.has(name)
}
