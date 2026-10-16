const MAX_SEARCH_TERMS = 12
const MAX_TERM_LENGTH = 64

export type MessageSearchCursor = {
  createdAt: string
  id: string
}

type CursorEnvelope = MessageSearchCursor & {
  version: 1
  channelId: string
  query: string
}

export const SEARCH_MESSAGES_SQL = `
  WITH matched AS (
    SELECT message_id
    FROM message_search
    WHERE message_search MATCH ?
  )
  SELECT
    messages.id AS id,
    messages.channel_id AS channelId,
    messages.author_id AS authorId,
    messages.content AS content,
    messages.edited_at AS editedAt,
    messages.created_at AS createdAt,
    users.kind AS authorKind,
    users.display_name AS authorDisplayName,
    users.avatar_r2_key AS authorAvatarR2Key
  FROM matched
  INNER JOIN messages ON messages.id = matched.message_id
  INNER JOIN users ON users.id = messages.author_id
  WHERE messages.channel_id = ?
    AND messages.deleted_at IS NULL
    AND (
      ? = 0
      OR messages.created_at < ?
      OR (messages.created_at = ? AND messages.id < ?)
    )
  ORDER BY messages.created_at DESC, messages.id DESC
  LIMIT ?
`

/** Turn user text into an FTS expression without exposing FTS5 query syntax. */
export function messageSearchExpression(input: string): string | null {
  const terms = input
    .normalize('NFKC')
    .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}_]*/gu)
    ?.slice(0, MAX_SEARCH_TERMS)
    .map(term => term.slice(0, MAX_TERM_LENGTH))
    .filter(Boolean) ?? []

  if (!terms.length) return null
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' AND ')
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeMessageSearchCursor(
  cursor: MessageSearchCursor,
  scope: { channelId: string; query: string },
): string {
  const payload: CursorEnvelope = {
    version: 1,
    channelId: scope.channelId,
    query: scope.query,
    createdAt: cursor.createdAt,
    id: cursor.id,
  }
  return base64UrlEncode(JSON.stringify(payload))
}

export function decodeMessageSearchCursor(
  value: string,
  scope: { channelId: string; query: string },
): MessageSearchCursor | null {
  try {
    const payload = JSON.parse(base64UrlDecode(value)) as Partial<CursorEnvelope>
    if (
      payload.version !== 1
      || payload.channelId !== scope.channelId
      || payload.query !== scope.query
      || typeof payload.createdAt !== 'string'
      || !payload.createdAt
      || typeof payload.id !== 'string'
      || !payload.id
    ) return null
    return { createdAt: payload.createdAt, id: payload.id }
  }
  catch {
    return null
  }
}
