import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeMessageSearchCursor,
  encodeMessageSearchCursor,
  messageSearchExpression,
  SEARCH_MESSAGES_SQL,
} from '../../server/utils/message-search'

describe('message search expression', () => {
  it('builds a prefix query from Unicode words without exposing FTS syntax', () => {
    expect(messageSearchExpression(' Привет, world OR "oops" ')).toBe('"Привет"* AND "world"* AND "OR"* AND "oops"*')
  })

  it('rejects punctuation-only searches', () => {
    expect(messageSearchExpression('!? — …')).toBeNull()
  })

  it('bounds the number and length of indexed terms', () => {
    const expression = messageSearchExpression(`${'x'.repeat(80)} a b c d e f g h i j k l m`)
    expect(expression?.split(' AND ')).toHaveLength(12)
    expect(expression).toContain(`"${'x'.repeat(64)}"*`)
  })
})

describe('message search cursor', () => {
  const scope = { channelId: 'channel-1', query: '"привет"*' }

  it('round-trips Unicode-bound cursor state', () => {
    const encoded = encodeMessageSearchCursor({ createdAt: '2026-09-04T12:00:00.000Z', id: 'message-1' }, scope)
    expect(decodeMessageSearchCursor(encoded, scope)).toEqual({
      createdAt: '2026-09-04T12:00:00.000Z',
      id: 'message-1',
    })
  })

  it('rejects malformed and cross-scope cursors', () => {
    const encoded = encodeMessageSearchCursor({ createdAt: '2026-09-04T12:00:00.000Z', id: 'message-1' }, scope)
    expect(decodeMessageSearchCursor('not-base64', scope)).toBeNull()
    expect(decodeMessageSearchCursor(encoded, { ...scope, channelId: 'private-channel' })).toBeNull()
    expect(decodeMessageSearchCursor(encoded, { ...scope, query: '"different"*' })).toBeNull()
  })
})

describe('message search SQL', () => {
  it('scopes before ordering and paginates with a stable timestamp/id tuple', () => {
    expect(SEARCH_MESSAGES_SQL).toContain('messages.channel_id = ?')
    expect(SEARCH_MESSAGES_SQL).toContain('messages.deleted_at IS NULL')
    expect(SEARCH_MESSAGES_SQL).toContain('messages.created_at = ? AND messages.id < ?')
    expect(SEARCH_MESSAGES_SQL).toContain('ORDER BY messages.created_at DESC, messages.id DESC')
  })

  it('keeps the FTS index derived and transactionally synchronized', () => {
    const path = fileURLToPath(new URL('../fixtures/legacy-migrations/0003_message_search.sql', import.meta.url))
    const migration = readFileSync(path, 'utf8')
    expect(migration).toContain('CREATE VIRTUAL TABLE `message_search` USING fts5')
    expect(migration).toContain('SELECT `id`, `content`\nFROM `messages`')
    expect(migration).toContain('AFTER INSERT ON `messages`')
    expect(migration).toContain('AFTER UPDATE OF `content`, `deleted_at` ON `messages`')
    expect(migration).toContain('AFTER DELETE ON `messages`')
  })

  it('ships a complete rebuild after virtual-table-free backup restores', () => {
    const path = fileURLToPath(new URL('../../drizzle/rebuild-message-search.sql', import.meta.url))
    const rebuild = readFileSync(path, 'utf8')
    expect(rebuild).toContain('DROP TABLE IF EXISTS `message_search`')
    expect(rebuild).toContain('CREATE VIRTUAL TABLE `message_search` USING fts5')
    expect(rebuild).toContain('CREATE TRIGGER `message_search_after_insert`')
    expect(rebuild).toContain("VALUES ('optimize')")
  })
})
