import { d1 } from '../helpers/sqlite-d1'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureAgentReplyTarget } from '../../workers/agent-replies'

let sqlite: DatabaseSync
let db: D1Database


beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      visibility TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      live_meeting_id TEXT,
      parent_id TEXT,
      parent_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX channels_thread_root_unique ON channels(parent_message_id) WHERE type = 'thread';
    CREATE TABLE channel_members (channel_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,message_id TEXT,filename TEXT,created_at TEXT);

    INSERT INTO channels VALUES
      ('dm', 'DM', '', 'dm', 'private', 0, NULL, NULL, NULL, 'now', 'now'),
      ('general', 'general', '', 'text', 'server', 0, NULL, NULL, NULL, 'now', 'now');
    INSERT INTO channel_members VALUES ('dm', 'human'), ('dm', 'agent');
    INSERT INTO messages VALUES
      ('dm-message', 'dm', 'Please inspect the build'),
      ('general-message', 'general', 'Hello');
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('agent reply target', () => {
  it('creates one thread for a root message in a one-to-one DM', async () => {
    const first = await ensureAgentReplyTarget(db, 'dm', 'dm-message')
    const second = await ensureAgentReplyTarget(db, 'dm', 'dm-message')

    expect(first).toMatchObject({ parentChannelId: 'dm', parentMessageId: 'dm-message', created: true })
    expect(first.channelId).not.toBe('dm')
    expect(second).toEqual({ ...first, created: false })
    expect(sqlite.prepare("SELECT name, parent_id, parent_message_id FROM channels WHERE type = 'thread'").all()).toEqual([
      { name: 'Please inspect the build', parent_id: 'dm', parent_message_id: 'dm-message' },
    ])
  })

  it('names an attachment-only thread after its file', async () => {
    sqlite.exec("INSERT INTO messages VALUES('file-message','dm',''); INSERT INTO attachments VALUES('file','file-message','report.pdf','now')")
    const target = await ensureAgentReplyTarget(db, 'dm', 'file-message')
    expect(sqlite.prepare('SELECT name FROM channels WHERE id=?').get(target.channelId)?.name).toBe('report.pdf')
  })

  it('creates a thread for a public channel root', async () => {
    const target = await ensureAgentReplyTarget(db, 'general', 'general-message')
    expect(target).toMatchObject({ parentChannelId: 'general', parentMessageId: 'general-message', created: true })
    expect(target.channelId).not.toBe('general')
    expect(await ensureAgentReplyTarget(db, target.channelId, 'unused')).toEqual({ channelId: target.channelId, parentChannelId: null, parentMessageId: null, created: false })
  })
})
