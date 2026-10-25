import { d1 } from '../helpers/sqlite-d1'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { channelLastMessageTimes, channelUnreadCountSql, channelUnreadCountsSql, channelUnreadSql, recentThreadsSql } from '../../workers/unread'

let db: DatabaseSync

function hasUnread(userId: string, channelId: string): boolean {
  const row = db.prepare(channelUnreadSql).get(channelId, channelId, userId, channelId) as { unread: number }
  return row.unread === 1
}

function unreadCount(userId: string, channelId: string): number {
  const row = db.prepare(channelUnreadCountSql).get(userId, channelId, channelId, channelId) as { unread_count: number }
  return row.unread_count
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT NOT NULL, parent_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE channel_reads (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_read_message_id TEXT,
      PRIMARY KEY (channel_id, user_id)
    );
  `)
})

afterEach(() => db.close())

describe('channel unread aggregation', () => {
  it('keeps a DM unread while one of its threads has unread replies', () => {
    db.exec(`
      INSERT INTO channels VALUES ('dm-1', 'dm', NULL), ('thread-1', 'thread', 'dm-1');
      INSERT INTO messages (id, channel_id) VALUES
        ('01990000-0000-7000-8000-000000000001', 'dm-1'),
        ('01990000-0000-7000-8000-000000000002', 'thread-1');
      INSERT INTO channel_reads VALUES
        ('dm-1', 'user-1', '01990000-0000-7000-8000-000000000001'),
        ('thread-1', 'user-1', '01990000-0000-7000-8000-000000000001');
    `)

    expect(hasUnread('user-1', 'dm-1')).toBe(true)
    expect(unreadCount('user-1', 'dm-1')).toBe(1)

    db.exec(`
      UPDATE channel_reads SET last_read_message_id = '01990000-0000-7000-8000-000000000002' WHERE channel_id = 'thread-1';
    `)
    expect(hasUnread('user-1', 'dm-1')).toBe(false)
    expect(unreadCount('user-1', 'dm-1')).toBe(0)
  })

  it('counts unread root and thread messages independently from their cursors', () => {
    db.exec(`
      INSERT INTO channels VALUES ('channel-1', 'text', NULL), ('thread-1', 'thread', 'channel-1');
      INSERT INTO messages (id, channel_id) VALUES
        ('01990000-0000-7000-8000-000000000001', 'channel-1'),
        ('01990000-0000-7000-8000-000000000002', 'channel-1'),
        ('01990000-0000-7000-8000-000000000003', 'thread-1');
      INSERT INTO channel_reads VALUES
        ('channel-1', 'user-1', '01990000-0000-7000-8000-000000000001'),
        ('thread-1', 'user-1', '01990000-0000-7000-8000-000000000001');
    `)

    expect(unreadCount('user-1', 'channel-1')).toBe(2)
  })

  it('counts many root channels with one grouped query', () => {
    db.exec(`
      INSERT INTO channels VALUES
        ('channel-1', 'text', NULL),
        ('channel-2', 'text', NULL),
        ('thread-1', 'thread', 'channel-1');
      INSERT INTO messages (id, channel_id) VALUES
        ('01990000-0000-7000-8000-000000000001', 'channel-1'),
        ('01990000-0000-7000-8000-000000000002', 'thread-1'),
        ('01990000-0000-7000-8000-000000000003', 'channel-2');
      INSERT INTO channel_reads VALUES
        ('channel-1', 'user-1', '01990000-0000-7000-8000-000000000001');
    `)

    const rows = db.prepare(channelUnreadCountsSql(2)).all('user-1', 'channel-1', 'channel-2')
    expect(rows).toEqual([
      { channel_id: 'channel-1', unread_count: 0 },
      { channel_id: 'channel-2', unread_count: 1 },
    ])
  })

  it('agrees across all three queries for never-opened, opened, deleted and isolated replies', () => {
    db.exec(`
      INSERT INTO channels VALUES ('root', 'text', NULL), ('thread', 'thread', 'root'), ('foreign', 'text', NULL);
      INSERT INTO messages (id, channel_id) VALUES ('m1', 'root'), ('m2', 'thread'), ('m3', 'thread'), ('m4', 'foreign');
      INSERT INTO channel_reads VALUES ('root', 'user-1', 'm1');
    `)
    const check = (count: number) => {
      expect(unreadCount('user-1', 'root')).toBe(count)
      expect(hasUnread('user-1', 'root')).toBe(count > 0)
      expect(db.prepare(channelUnreadCountsSql(1)).get('user-1', 'root')).toEqual({ channel_id: 'root', unread_count: count })
    }
    check(0) // Never-opened replies do not keep the parent unread forever.
    db.exec("INSERT INTO channel_reads VALUES ('thread', 'user-1', 'm1')")
    check(2)
    db.exec("UPDATE messages SET deleted_at = '2026-10-24' WHERE id = 'm3'")
    check(1)
    db.exec("UPDATE channel_reads SET last_read_message_id = 'm2' WHERE channel_id = 'thread'")
    check(0)
    db.exec("INSERT INTO messages (id, channel_id, deleted_at) VALUES ('m5', 'root', '2026-10-24')")
    check(0)
    expect(unreadCount('other-user', 'root')).toBe(1)
  })

  it('does not let an older tab regress a newer read cursor', () => {
    db.exec(`
      INSERT INTO channels VALUES ('channel-1', 'text', NULL);
      INSERT INTO messages (id, channel_id) VALUES
        ('01990000-0000-7000-8000-000000000001', 'channel-1'),
        ('01990000-0000-7000-8000-000000000002', 'channel-1');
      INSERT INTO channel_reads VALUES
        ('channel-1', 'user-1', '01990000-0000-7000-8000-000000000002');
      INSERT INTO channel_reads VALUES
        ('channel-1', 'user-1', '01990000-0000-7000-8000-000000000001')
      ON CONFLICT(channel_id, user_id) DO UPDATE
      SET last_read_message_id = excluded.last_read_message_id
      WHERE channel_reads.last_read_message_id IS NULL
         OR channel_reads.last_read_message_id < excluded.last_read_message_id;
    `)

    expect(hasUnread('user-1', 'channel-1')).toBe(false)
    expect(db.prepare(
      'SELECT last_read_message_id FROM channel_reads WHERE channel_id = ? AND user_id = ?',
    ).get('channel-1', 'user-1')).toEqual({
      last_read_message_id: '01990000-0000-7000-8000-000000000002',
    })
  })
})

describe('recent threads for the navigation', () => {
  let tdb: DatabaseSync

  beforeEach(() => {
    tdb = new DatabaseSync(':memory:')
    tdb.exec(`
      CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z');
      CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE channel_reads (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, last_read_message_id TEXT, PRIMARY KEY (channel_id, user_id));
      INSERT INTO channels(id,type,parent_id,name) VALUES
        ('channel-1', 'text', NULL, 'general'),
        ('recent', 'thread', 'channel-1', 'Recent thread'),
        ('stale', 'thread', 'channel-1', 'Stale thread'),
        ('stale-unread', 'thread', 'channel-1', 'Stale but unread'),
        ('never-opened', 'thread', 'channel-1', 'Never opened');
      INSERT INTO messages (id, channel_id, created_at) VALUES
        ('m1', 'recent', '2026-09-27T10:00:00.000Z'),
        ('m2', 'stale', '2026-09-01T10:00:00.000Z'),
        ('m3', 'stale-unread', '2026-09-01T10:00:00.000Z'),
        ('m4', 'stale-unread', '2026-09-01T11:00:00.000Z'),
        ('m5', 'never-opened', '2026-09-01T10:00:00.000Z');
      INSERT INTO channel_reads VALUES
        ('stale', 'user-1', 'm2'),
        ('stale-unread', 'user-1', 'm3');
    `)
  })

  afterEach(() => tdb.close())

  it('shows a newly created agent thread while its reply is still queued', () => {
    tdb.exec("INSERT INTO channels VALUES ('queued', 'thread', 'channel-1', 'Waiting for the agent', '2026-09-27T10:00:00.000Z')")
    const rows = tdb.prepare(recentThreadsSql).all('user-1', '2026-09-20T00:00:00.000Z')
    expect(rows).toContainEqual(expect.objectContaining({ id: 'queued', unreadCount: 0, lastMessageAt: '2026-09-27T10:00:00.000Z' }))
  })

  it('excludes deleted replies from navigation counts and last activity', async () => {
    tdb.exec("UPDATE messages SET deleted_at = '2026-09-28' WHERE id = 'm4'")
    const rows = tdb.prepare(recentThreadsSql).all('user-1', '2026-09-20T00:00:00.000Z')
    expect(rows.map(row => row.id)).toEqual(['recent'])
    expect(await channelLastMessageTimes(d1(tdb), ['channel-1', 'absent'])).toEqual(new Map([['channel-1', '2026-09-27T10:00:00.000Z']]))
    tdb.exec("UPDATE messages SET deleted_at = '2026-09-28'")
    expect(await channelLastMessageTimes(d1(tdb), ['channel-1'])).toEqual(new Map([['channel-1', null]]))
  })

  it('keeps recently active threads and older ones with unread replies the member has opened', () => {
    const rows = tdb.prepare(recentThreadsSql).all('user-1', '2026-09-20T00:00:00.000Z') as Array<{ id: string, unreadCount: number, title: string }>
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    expect(Object.keys(byId).sort()).toEqual(['recent', 'stale-unread'])
    expect(byId['stale-unread']).toMatchObject({ title: 'Stale but unread', unreadCount: 1, opened: 1 })
    expect(byId.recent).toMatchObject({ unreadCount: 0, opened: 0 })
  })
})
