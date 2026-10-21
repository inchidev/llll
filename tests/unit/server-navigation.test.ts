import { describe, expect, it } from 'vitest'
import { hasServerNavigationMenu, serverNavigationSection } from '../../shared/server-navigation'

describe('Server rail destinations', () => {
  it('keeps channels, DMs and threads in Chat', () => {
    expect(serverNavigationSection('/channels')).toBe('chat')
    expect(serverNavigationSection('/channels/dm-id')).toBe('chat')
    expect(serverNavigationSection('/channels/channel-id/threads/thread-id')).toBe('chat')
    expect(hasServerNavigationMenu('/channels/channel-id')).toBe(true)
  })

  it('opens context menus and keeps Runs with Tasks', () => {
    for (const section of ['tasks', 'mail', 'inbox', 'agents', 'gadgets']) {
      expect(serverNavigationSection(`/${section}`)).toBe(section)
      expect(hasServerNavigationMenu(`/${section}`)).toBe(true)
    }
    for (const path of ['/data', '/databases/db-id', '/documents', '/canvases']) {
      expect(serverNavigationSection(path)).toBe('data')
      expect(hasServerNavigationMenu(path)).toBe(true)
    }
    expect(serverNavigationSection('/runs/run-id')).toBe('tasks')
  })

  it('leaves Schedule and settings with only the compact rail', () => {
    for (const path of ['/schedules', '/server/server-id/settings', '/channels-other']) {
      expect(hasServerNavigationMenu(path)).toBe(false)
    }
    expect(serverNavigationSection('/channels-other')).toBeNull()
  })
})
