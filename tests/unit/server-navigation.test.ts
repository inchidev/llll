import { describe, expect, it } from 'vitest'
import { hasServerNavigationMenu, serverNavigationSection } from '../../shared/server-navigation'

describe('Server rail destinations', () => {
  it('keeps channels, DMs and threads in Chat', () => {
    expect(serverNavigationSection('/channels')).toBe('chat')
    expect(serverNavigationSection('/channels/dm-id')).toBe('chat')
    expect(serverNavigationSection('/channels/channel-id/threads/thread-id')).toBe('chat')
    expect(hasServerNavigationMenu('/channels/channel-id')).toBe(true)
  })

  it('opens independent data menus and keeps Runs with Tasks', () => {
    for (const section of ['tasks', 'mail', 'databases', 'documents', 'canvases', 'gadgets']) {
      expect(serverNavigationSection(`/${section}`)).toBe(section)
      expect(hasServerNavigationMenu(`/${section}`)).toBe(true)
    }
    expect(serverNavigationSection('/runs/run-id')).toBe('tasks')
  })

  it('leaves Inbox, Schedule and settings with only the compact rail', () => {
    for (const path of ['/inbox', '/schedules', '/server/server-id/settings', '/channels-other']) {
      expect(hasServerNavigationMenu(path)).toBe(false)
    }
    expect(serverNavigationSection('/channels-other')).toBeNull()
  })
})
