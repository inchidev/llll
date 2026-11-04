export type ConnectionsTab = 'shortcut' | 'apps' | 'tokens'

/** Sections that became tabs of Connections. Their old addresses keep working. */
const CONNECTIONS_TABS: Record<string, ConnectionsTab> = { shortcut: 'shortcut', mcp: 'tokens' }

export function connectionsTabFor(section: string, isOwner: boolean): ConnectionsTab | null {
  const tab = CONNECTIONS_TABS[section]
  if (!tab) return null
  // Access tokens are the Owner's; anyone else lands where a stale ?section= has always landed.
  return tab === 'tokens' && !isOwner ? null : tab
}
