import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteAgentTurn, listAgentTurns, patchAgentTurn, putAgentTurn } from '../../workers/agent-turns'

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
          const result = database.prepare(sql).run(...values)
          return { meta: { changes: result.changes } }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_turns (
      submission_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      initiated_by TEXT NOT NULL,
      request_id TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      draft_message_id TEXT,
      approval_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('agent turn state', () => {
  it('persists queue, streaming draft, and approval state for cold reconnects', async () => {
    const env = { DB: db }
    await putAgentTurn(env as never, {
      submissionId: 'submission-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
      sourceMessageId: 'message-1',
      initiatedBy: 'human-1',
      status: 'queued',
      detail: 'Queued',
    })
    await patchAgentTurn(env as never, 'submission-1', {
      requestId: 'request-1',
      status: 'waiting_approval',
      draftMessageId: 'draft-1',
      approval: {
        executionId: 'execution-1',
        action: 'mail_reply',
        summary: 'Send an email reply',
        input: { threadId: 'thread-1' },
        risk: 'medium',
      },
    })

    expect(await listAgentTurns(env as never, 'channel-1')).toEqual([
      expect.objectContaining({
        submissionId: 'submission-1',
        status: 'waiting_approval',
        draftMessageId: 'draft-1',
        approval: expect.objectContaining({ executionId: 'execution-1' }),
      }),
    ])

    await deleteAgentTurn(env as never, 'submission-1')
    expect(await listAgentTurns(env as never, 'channel-1')).toEqual([])
  })
})
