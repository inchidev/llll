import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'
import { applyWorkspaceRealtimeEvent } from '../../app/utils/workspace-realtime'
import { channelActivityAudience, signalChannelActivity } from '../../workers/channel-activity'
import { sendWorkspaceEvent } from '../../workers/workspace-events'

let sqlite: DatabaseSync
let db: D1Database

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...next: unknown[]) {
          values = next
          return statement
        },
        async first<T>() {
          return (database.prepare(sql).get(...values) as T | undefined) ?? null
        },
        async all<T>() {
          return { results: database.prepare(sql).all(...values) as T[] }
        },
        async run() {
          database.prepare(sql).run(...values)
          return { success: true }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, visibility TEXT NOT NULL, parent_id TEXT);
    CREATE TABLE channel_members (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, hidden_at TEXT);
    INSERT INTO users VALUES
      ('author', 'active'),
      ('member-a', 'active'),
      ('member-b', 'active'),
      ('outsider', 'active'),
      ('removed', 'removed');
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('channel activity audience', () => {
  it('targets every other active member for a workspace channel', async () => {
    sqlite.exec(`INSERT INTO channels VALUES ('general', 'general', 'text', 'workspace', NULL);`)

    await expect(channelActivityAudience(db, 'general', 'author')).resolves.toEqual({
      sourceChannelId: 'general',
      rootChannelId: 'general',
      rootName: 'general',
      rootType: 'text',
      recipientIds: ['member-a', 'member-b', 'outsider'],
    })
  })

  it('does not leak private-channel activity to non-members', async () => {
    sqlite.exec(`
      INSERT INTO channels VALUES ('private', 'private', 'text', 'private', NULL);
      INSERT INTO channel_members (channel_id, user_id) VALUES
        ('private', 'author'),
        ('private', 'member-a'),
        ('private', 'removed');
    `)

    await expect(channelActivityAudience(db, 'private', 'author')).resolves.toEqual({
      sourceChannelId: 'private',
      rootChannelId: 'private',
      rootName: 'private',
      rootType: 'text',
      recipientIds: ['member-a'],
    })
  })

  it('maps a DM thread to its parent and only targets active DM participants', async () => {
    sqlite.exec(`
      INSERT INTO channels VALUES
        ('dm', 'dm', 'dm', 'private', NULL),
        ('thread', 'thread', 'thread', 'private', 'dm');
      INSERT INTO channel_members (channel_id, user_id) VALUES
        ('dm', 'author'),
        ('dm', 'member-b'),
        ('dm', 'removed');
    `)

    await expect(channelActivityAudience(db, 'thread', 'author')).resolves.toEqual({
      sourceChannelId: 'thread',
      rootChannelId: 'dm',
      rootName: 'dm',
      rootType: 'dm',
      recipientIds: ['member-b'],
    })
  })

  it('unhides a DM root before publishing thread activity', async () => {
    sqlite.exec(`
      INSERT INTO channels VALUES
        ('dm', 'dm', 'dm', 'private', NULL),
        ('thread', 'thread', 'thread', 'private', 'dm');
      INSERT INTO channel_members VALUES
        ('dm', 'author', NULL),
        ('dm', 'member-b', '2026-09-04T00:00:00Z');
    `)
    const notifyChannelActivity = vi.fn(async () => {
      expect(sqlite.prepare(
        'SELECT hidden_at FROM channel_members WHERE channel_id = ? AND user_id = ?',
      ).get('dm', 'member-b')).toEqual({ hidden_at: null })
    })
    const env = {
      DB: db,
      WORKSPACE_DO: { getByName: () => ({ notifyChannelActivity }) },
    }

    await signalChannelActivity(env as never, {
      id: 'message-1',
      channelId: 'thread',
      author: { id: 'author', kind: 'human', displayName: 'Alice', avatarR2Key: null },
      content: 'hello from the thread',
      attachmentCount: 0,
    })

    expect(notifyChannelActivity).toHaveBeenCalledWith({
      t: 'channel.activity',
      sourceChannelId: 'thread',
      rootChannelId: 'dm',
      messageId: 'message-1',
      notification: {
        title: 'Alice',
        body: 'hello from the thread',
        url: '/channels/dm/threads/thread',
      },
    }, ['member-b'])
  })
})

describe('workspace event delivery', () => {
  it('delivers to every tab of a recipient and no other socket', () => {
    const allowedA = vi.fn()
    const allowedB = vi.fn()
    const outsider = vi.fn()
    const sockets = [
      { deserializeAttachment: () => ({ userId: 'member-a', lastActive: 1 }), send: allowedA },
      { deserializeAttachment: () => ({ userId: 'member-a', lastActive: 2 }), send: allowedB },
      { deserializeAttachment: () => ({ userId: 'outsider', lastActive: 2 }), send: outsider },
      { deserializeAttachment: () => null, send: vi.fn() },
    ]
    const event = {
      t: 'channel.activity' as const,
      sourceChannelId: 'thread',
      rootChannelId: 'private',
      messageId: '01990000-0000-7000-8000-000000000001',
      notification: { title: 'Alice in #private', body: 'hello', url: '/channels/private/threads/thread' },
    }

    sendWorkspaceEvent(sockets, new Set(['member-a']), event)

    expect(allowedA).toHaveBeenCalledWith(JSON.stringify(event))
    expect(allowedB).toHaveBeenCalledWith(JSON.stringify(event))
    expect(outsider).not.toHaveBeenCalled()
  })
})

describe('workspace unread cache events', () => {
  it('marks the root channel unread for newer thread activity', () => {
    const cache = new QueryClient()
    cache.setQueryData(['channels', 'main'], { channels: [{ id: 'parent', unread: false }] })

    applyWorkspaceRealtimeEvent(cache, {
      t: 'channel.activity',
      sourceChannelId: 'thread',
      rootChannelId: 'parent',
      messageId: '01990000-0000-7000-8000-000000000002',
      notification: { title: 'Alice in #parent', body: 'hello', url: '/channels/parent/threads/thread' },
    })

    expect(cache.getQueryData(['channels', 'main'])).toEqual({ channels: [{ id: 'parent', unread: true, unreadCount: 1 }] })
  })

  it('ignores activity at or behind a cursor already read in another delivery order', () => {
    const cache = new QueryClient()
    cache.setQueryData(['dms'], { channels: [{ id: 'dm', unread: false }] })
    cache.setQueryData(['readCursor', 'thread'], '01990000-0000-7000-8000-000000000002')

    applyWorkspaceRealtimeEvent(cache, {
      t: 'channel.activity',
      sourceChannelId: 'thread',
      rootChannelId: 'dm',
      messageId: '01990000-0000-7000-8000-000000000002',
      notification: { title: 'Alice', body: 'hello', url: '/channels/dm/threads/thread' },
    })

    expect(cache.getQueryData(['dms'])).toEqual({ channels: [{ id: 'dm', unread: false }] })
  })

  it('applies a remote-tab read to every cached parent list', () => {
    const cache = new QueryClient()
    cache.setQueryData(['channels', 'main'], { channels: [{ id: 'parent', unread: true }] })
    cache.setQueryData(['dms'], { channels: [{ id: 'parent', unread: true }] })

    applyWorkspaceRealtimeEvent(cache, {
      t: 'channel.read',
      sourceChannelId: 'thread',
      rootChannelId: 'parent',
      messageId: '01990000-0000-7000-8000-000000000003',
      unread: false,
    })

    expect(cache.getQueryData(['readCursor', 'thread'])).toBe('01990000-0000-7000-8000-000000000003')
    expect(cache.getQueryData(['channels', 'main'])).toEqual({ channels: [{ id: 'parent', unread: false, unreadCount: 0 }] })
    expect(cache.getQueryData(['dms'])).toEqual({ channels: [{ id: 'parent', unread: false, unreadCount: 0 }] })
  })

  it('invalidates lists so a hidden DM can reappear on new activity', () => {
    const cache = new QueryClient()
    cache.setQueryData(['channels', 'main'], { channels: [] })
    cache.setQueryData(['dms'], { channels: [] })

    applyWorkspaceRealtimeEvent(cache, {
      t: 'channel.activity',
      sourceChannelId: 'dm',
      rootChannelId: 'dm',
      messageId: '01990000-0000-7000-8000-000000000004',
      notification: { title: 'Alice', body: 'hello', url: '/channels/dm' },
    })

    expect(cache.getQueryState(['channels', 'main'])?.isInvalidated).toBe(true)
    expect(cache.getQueryState(['dms'])?.isInvalidated).toBe(true)
  })

  it('invalidates task boards and the changed task detail', () => {
    const cache = new QueryClient()
    cache.setQueryData(['boards', 'main', false], { boards: [] })
    cache.setQueryData(['task', 'task-1'], { task: { id: 'task-1' } })

    applyWorkspaceRealtimeEvent(cache, { t: 'tasks.changed', boardId: 'board-1', taskId: 'task-1' })

    expect(cache.getQueryState(['boards', 'main', false])?.isInvalidated).toBe(true)
    expect(cache.getQueryState(['task', 'task-1'])?.isInvalidated).toBe(true)
  })

  it('invalidates the member directory when workspace membership changes', () => {
    const cache = new QueryClient()
    cache.setQueryData(['members', 'main'], { members: [] })

    applyWorkspaceRealtimeEvent(cache, {
      t: 'members.changed',
      workspaceId: 'main',
    } as never)

    expect(cache.getQueryState(['members', 'main'])?.isInvalidated).toBe(true)
  })

  it('counts replies as unread only in threads the member has opened, and clears them on read', () => {
    const cache = new QueryClient()
    const thread = (id: string, opened: boolean) => ({ id, parentId: 'parent', title: id, lastMessageAt: '2026-09-27T10:00:00.000Z', opened, unread: false, unreadCount: 0 })
    cache.setQueryData(['channels', 'main'], { channels: [{ id: 'parent', unread: false }], threads: [thread('opened', true), thread('new', false)] })
    const activity = (sourceChannelId: string, n: number) => applyWorkspaceRealtimeEvent(cache, {
      t: 'channel.activity',
      sourceChannelId,
      rootChannelId: 'parent',
      messageId: `01990000-0000-7000-8000-00000000000${n}`,
      notification: { title: 'Alice', body: 'hi', url: `/channels/parent/threads/${sourceChannelId}` },
    })

    activity('opened', 1)
    activity('new', 2)
    type Threads = { threads: Array<{ id: string, unread: boolean, unreadCount: number }> }
    const threads = () => Object.fromEntries((cache.getQueryData<Threads>(['channels', 'main'])?.threads ?? []).map(item => [item.id, item]))
    expect(threads().opened).toMatchObject({ unread: true, unreadCount: 1 })
    expect(threads().new).toMatchObject({ unread: false, unreadCount: 0 })

    applyWorkspaceRealtimeEvent(cache, {
      t: 'channel.read',
      sourceChannelId: 'opened',
      rootChannelId: 'parent',
      messageId: '01990000-0000-7000-8000-000000000003',
      unread: false,
    })
    expect(threads().opened).toMatchObject({ unread: false, unreadCount: 0 })
  })
})
