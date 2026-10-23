import { channelPath, type ChannelRef } from './paths'

export type ServerNavigationSection = 'chat' | 'inbox' | 'agents' | 'tasks' | 'schedules' | 'mail' | 'data' | 'gadgets'

/** The Chat rail must not reopen an Agent DM remembered by an older Client. */
export function chatNavigationTarget(conversations: readonly ChannelRef[], lastId?: string): string {
  const last = conversations.find(channel => channel.id === lastId)
  const path = last ? channelPath(last) : '/channels'
  return path.startsWith('/agents/') ? '/channels' : path
}

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
