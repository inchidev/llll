export type ServerNavigationSection = 'chat' | 'inbox' | 'agents' | 'tasks' | 'schedules' | 'mail' | 'data' | 'gadgets'

/** Resource routes retain their section; Schedule uses the content area directly. */
export function serverNavigationSection(path: string): ServerNavigationSection | null {
  const segment = path.split('/')[1]
  if (segment === 'channels') return 'chat'
  if (segment === 'runs') return 'tasks'
  if (['data', 'databases', 'documents', 'canvases'].includes(segment || '')) return 'data'
  if (segment === 'inbox' || segment === 'agents' || segment === 'tasks' || segment === 'schedules' || segment === 'mail' || segment === 'gadgets') return segment
  return null
}

export function hasServerNavigationMenu(path: string): boolean {
  const section = serverNavigationSection(path)
  return section !== null && section !== 'schedules'
}
