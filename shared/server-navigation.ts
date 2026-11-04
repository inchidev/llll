import { channelPath, type ChannelRef } from './paths'

export type ServerNavigationSection = 'chat' | 'inbox' | 'tasks' | 'factory' | 'mail' | 'agents' | 'data' | 'gadgets'

/** The Chat rail must not reopen an Agent DM remembered by an older Client. */
export function chatNavigationTarget(conversations: readonly ChannelRef[], lastId?: string): string {
  const last = conversations.find(channel => channel.id === lastId)
  const path = last ? channelPath(last) : '/channels'
  return path.startsWith('/agents/') ? '/channels' : path
}

/**
 * Resource routes retain their section. Tasks holds boards and Tasks, and Factory holds coding work:
 * Projects with repositories, and Runs. A Schedule reminds or runs an Agent, so it sits in Agents.
 */
export function serverNavigationSection(path: string): ServerNavigationSection | null {
  const segment = path.split('/')[1]
  if (segment === 'channels') return 'chat'
  const next = path.split('/')[2]
  if (segment === 'tasks' || (segment === 'projects' && ['board', 'my-tasks', 'mark'].includes(next || ''))) return 'tasks'
  if (segment === 'projects' || segment === 'factory' || segment === 'runs') return 'factory'
  if (segment === 'schedules') return 'agents'
  if (['data', 'databases', 'items'].includes(segment || '')) return 'data'
  if (segment === 'inbox' || segment === 'agents' || segment === 'mail' || segment === 'gadgets') return segment
  return null
}

export function hasServerNavigationMenu(path: string): boolean {
  return serverNavigationSection(path) !== null
}
