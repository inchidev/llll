export type ServerNavigationSection = 'chat' | 'inbox' | 'tasks' | 'schedules' | 'mail' | 'databases' | 'documents' | 'canvases' | 'gadgets'

/** Resource routes retain their section; Inbox and Schedule use the content area directly. */
export function serverNavigationSection(path: string): ServerNavigationSection | null {
  const segment = path.split('/')[1]
  if (segment === 'channels') return 'chat'
  if (segment === 'runs') return 'tasks'
  if (segment === 'inbox' || segment === 'tasks' || segment === 'schedules' || segment === 'mail' || segment === 'databases' || segment === 'documents' || segment === 'canvases' || segment === 'gadgets') return segment
  return null
}

export function hasServerNavigationMenu(path: string): boolean {
  const section = serverNavigationSection(path)
  return section !== null && section !== 'inbox' && section !== 'schedules'
}
