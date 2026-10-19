import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signalAgentsForMessage } from '../../workers/agent-ingress'

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
      }
      return statement
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE roles (id TEXT PRIMARY KEY, permissions_bitmask INTEGER NOT NULL);
    CREATE TABLE server (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, role_id TEXT NOT NULL);
    CREATE TABLE agents (user_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT NOT NULL, visibility TEXT NOT NULL, parent_id TEXT);
    CREATE TABLE channel_members (channel_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT, content_type TEXT NOT NULL);

    INSERT INTO roles VALUES ('admin-role', 1), ('member-role', 112);
    INSERT INTO server VALUES ('main', 'owner');
    INSERT INTO users VALUES
      ('owner', 'human', 'active', 'member-role'),
      ('human', 'human', 'active', 'admin-role'),
      ('member', 'human', 'active', 'member-role'),
      ('agent', 'agent', 'active', 'member-role');
    INSERT INTO agents VALUES ('agent', 'active');
    INSERT INTO channels VALUES
      ('dm', 'dm', 'private', NULL),
      ('thread', 'thread', 'private', 'dm');
    INSERT INTO channel_members VALUES
      ('dm', 'human'),
      ('dm', 'agent');
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('agent message ingress', () => {
  it('keeps addressing the agent inside a one-to-one DM thread', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI: {},
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-thread',
      channelId: 'thread',
      authorId: 'human',
      authorName: 'Human',
      content: 'Continue here',
      mentionIds: [],
      mode: 'steer',
    })

    expect(receiveMessage).toHaveBeenCalledWith({
      messageId: 'message-thread',
      channelId: 'thread',
      authorId: 'human',
      authorName: 'Human',
      content: 'Continue here',
      hasImages: false,
      mode: 'steer',
    })
  })

  it('starts a DM turn for an image-only message', async () => {
    sqlite.exec("INSERT INTO attachments VALUES ('image-1', 'message-image', 'image/png')")
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI: {},
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-image',
      channelId: 'dm',
      authorId: 'human',
      authorName: 'Human',
      content: '',
      mentionIds: [],
    })

    expect(receiveMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'message-image',
      content: '',
      hasImages: true,
    }))
  })

  it('starts a turn through an OpenAI-compatible endpoint when Workers AI is absent', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI_BASE_URL: 'https://llm.example.com/v1',
      AI_API_KEY: 'secret',
      AI_MODEL: 'your-model',
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-compatible',
      channelId: 'dm',
      authorId: 'human',
      authorName: 'Human',
      content: 'Hello',
      mentionIds: [],
    })

    expect(receiveMessage).toHaveBeenCalled()
  })

  it('does not start a turn without a model provider', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-no-ai',
      channelId: 'dm',
      authorId: 'human',
      authorName: 'Human',
      content: 'Hello',
      mentionIds: [],
    })

    expect(receiveMessage).not.toHaveBeenCalled()
  })

  it('does not let a chat-only member start an agent turn', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI: {},
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-member',
      channelId: 'dm',
      authorId: 'member',
      authorName: 'Member',
      content: 'Run this command',
      mentionIds: ['agent'],
    })

    expect(receiveMessage).not.toHaveBeenCalled()
  })
})
