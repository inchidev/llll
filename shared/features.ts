import type { PermissionGrantKey } from './permissions'
import type { ServerNavigationSection } from './server-navigation'
import type { McpScope } from './mcp'
import type { AiFunctionId } from './ai-functions'

/**
 * Product areas paused while their design is still open: Apps for now.
 * Only their entry points are hidden: the Client navigation and routes, their Role grants,
 * their AI functions in Settings, and the agent and MCP tools. Stored data, HTTP APIs and existing grants stay intact, so
 * turning an area back on is a matter of removing it from these lists.
 */
export const pausedSections: ReadonlySet<ServerNavigationSection> = new Set(['gadgets'])

export const pausedPermissionKeys: ReadonlySet<PermissionGrantKey> = new Set(['useGadgets', 'manageGadgets'])

export const pausedAiFunctions: ReadonlySet<AiFunctionId> = new Set(['apps.assist'])

export const pausedMcpScopes: ReadonlySet<McpScope> = new Set()

const pausedTools = new Set([
  // Apps: Agents draft them once the Apps area is back.
  'list_app_drafts', 'get_app_draft', 'create_app_draft', 'update_app_draft',
])

/** Agent and MCP tools of a paused area are neither discoverable nor callable. */
export function toolPaused(name: string): boolean {
  return pausedTools.has(name)
}
