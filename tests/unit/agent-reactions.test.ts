import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { replaceAgentReaction } from '../../workers/agent-reactions'

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
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map(statement => statement.run()))
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('agent lifecycle reactions', () => {
  it('moves from seen to complete without changing human reactions', async () => {
    sqlite.prepare('INSERT INTO message_reactions VALUES (?, ?, ?, ?)').run('message', 'human', '👀', 'now')

    expect(await replaceAgentReaction(db, 'message', 'agent', '👀')).toEqual({ removed: [], added: '👀' })
    expect(await replaceAgentReaction(db, 'message', 'agent', '✅')).toEqual({ removed: ['👀'], added: '✅' })
    expect(sqlite.prepare('SELECT user_id, emoji FROM message_reactions ORDER BY user_id').all()).toEqual([
      { user_id: 'agent', emoji: '✅' },
      { user_id: 'human', emoji: '👀' },
    ])
  })

  it('is idempotent when a workflow step is retried', async () => {
    await replaceAgentReaction(db, 'message', 'agent', '❌')

    expect(await replaceAgentReaction(db, 'message', 'agent', '❌')).toEqual({ removed: [], added: null })
    expect(sqlite.prepare('SELECT emoji FROM message_reactions').all()).toEqual([{ emoji: '❌' }])
  })

  it('does not regress a completed message to seen when ingress is retried', async () => {
    await replaceAgentReaction(db, 'message', 'agent', '✅')

    expect(await replaceAgentReaction(db, 'message', 'agent', '👀')).toEqual({ removed: [], added: null })
    expect(sqlite.prepare('SELECT emoji FROM message_reactions').all()).toEqual([{ emoji: '✅' }])
  })
})
