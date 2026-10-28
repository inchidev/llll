import { dmTitle } from '../../shared/dm'
import { channelPath } from '../../shared/paths'
import { hasPermission, Permission } from '../../shared/permissions'
import type { ChannelType, MessageSearchHitDTO, MessageSearchResponse, PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireChannelAccessForMember, type ServerChannelAccess, type ServerMembership } from './channel-access'

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

const SEARCH_COLUMNS = `
    messages.id AS id,
    messages.channel_id AS channelId,
    messages.author_id AS authorId,
    messages.content AS content,
    messages.edited_at AS editedAt,
    messages.created_at AS createdAt,
    users.kind AS authorKind,
    users.display_name AS authorDisplayName,
    users.avatar_r2_key AS authorAvatarR2Key,
    channels.name AS channelName,
    channels.type AS channelType,
    channels.parent_id AS parentId,
    channels.parent_message_id AS parentMessageId,
    root.id AS rootId,
    root.name AS rootName,
    root.type AS rootType`

const SEARCH_JOINS = `
  FROM matched
  INNER JOIN messages ON messages.id = matched.message_id
  INNER JOIN users ON users.id = messages.author_id
  INNER JOIN channels ON channels.id = messages.channel_id
  INNER JOIN channels root ON root.id =
    CASE WHEN channels.type = 'thread' AND channels.parent_id IS NOT NULL THEN channels.parent_id ELSE channels.id END`

/** One conversation and the threads under it. Binds query, channel, cursor flag, createdAt, createdAt, id, limit. */
export const SEARCH_MESSAGES_SQL = `
  WITH matched AS (
    SELECT message_id
    FROM message_search
    WHERE message_search MATCH ?1
  )
  SELECT ${SEARCH_COLUMNS}
  ${SEARCH_JOINS}
  WHERE (messages.channel_id = ?2 OR root.id = ?2)
    AND messages.deleted_at IS NULL
    AND (
      ?3 = 0
      OR messages.created_at < ?4
      OR (messages.created_at = ?5 AND messages.id < ?6)
    )
  ORDER BY messages.created_at DESC, messages.id DESC
  LIMIT ?7
`

/**
 * Every conversation the member can open from chat navigation: open channels,
 * private channels and DMs they belong to, and their threads. Mailboxes and task
 * discussions keep their own access and are not searched here. Agent DMs follow
 * the interface rule. The channel guard still confirms each returned root.
 */
export const SEARCH_SERVER_MESSAGES_SQL = `
  WITH matched AS (
    SELECT message_id
    FROM message_search
    WHERE message_search MATCH ?1
  )
  SELECT ${SEARCH_COLUMNS}
  ${SEARCH_JOINS}
  WHERE messages.deleted_at IS NULL
    AND (root.visibility = 'server' OR EXISTS
      (SELECT 1 FROM channel_members cm WHERE cm.channel_id = root.id AND cm.user_id = ?2))
    AND (?10 IS NULL OR root.visibility = 'server' OR EXISTS
      (SELECT 1 FROM channel_members cm WHERE cm.channel_id = root.id AND cm.user_id = ?10))
    AND NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = root.id)
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = root.id)
    AND (?3 = 1 OR root.type <> 'dm' OR NOT EXISTS
      (SELECT 1 FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = root.id AND u.kind = 'agent'))
    AND (?4 IS NULL OR root.id = ?4 OR channels.id = ?4)
    AND (?5 IS NULL OR messages.author_id = ?5)
    AND (
      ?6 = 0
      OR messages.created_at < ?7
      OR (messages.created_at = ?7 AND messages.id < ?8)
    )
  ORDER BY messages.created_at DESC, messages.id DESC
  LIMIT ?9
`

export type SearchRow = {
  id: string
  channelId: string
  authorId: string
  content: string
  editedAt: string | null
  createdAt: string
  authorKind: 'human' | 'agent'
  authorDisplayName: string
  authorAvatarR2Key: string | null
  channelName: string
  channelType: ChannelType
  parentId: string | null
  parentMessageId: string | null
  rootId: string
  rootName: string
  rootType: ChannelType
}

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

/** A hit with its conversation title and a thread-aware link; append `?message=<id>` to open it in context. */
export function searchHit(row: SearchRow, root: { participants: PublicUser[] }, viewerId: string): MessageSearchHitDTO {
  const agentDm = row.rootType === 'dm' && root.participants.some(participant => participant.kind === 'agent')
  const rootRef = { id: row.rootId, type: row.rootType, participants: agentDm ? [{ kind: 'agent' }] : [] }
  const thread = row.channelType === 'thread' && row.rootId !== row.channelId
  return {
    id: row.id,
    channel: {
      id: row.channelId,
      name: row.channelName,
      type: row.channelType,
      parentId: row.parentId,
      parentMessageId: row.parentMessageId,
      title: row.rootType === 'dm' ? dmTitle(row.rootName, root.participants, viewerId) : row.rootName,
      path: thread ? channelPath(rootRef, row.channelId) : channelPath(rootRef),
    },
    author: {
      id: row.authorId,
      kind: row.authorKind,
      displayName: row.authorDisplayName,
      avatarR2Key: row.authorAvatarR2Key,
    },
    content: row.content,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
  }
}

export type ServerSearchInput = {
  q: string
  cursor?: string | null
  limit?: number
  /** A channel or DM (with its threads) or one thread. */
  channelId?: string | null
  authorId?: string | null
}

/** Search every conversation the member can read in chat, newest first. */
export async function searchServerMessages(env: L4Env, member: ServerMembership, input: ServerSearchInput): Promise<MessageSearchResponse> {
  const expression = messageSearchExpression(input.q)
  if (!expression) fail(400, 'bad_request', 'Search query must contain a letter or number')
  const pageSize = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 50))
  const scope = { channelId: `server:${input.channelId ?? ''}:${input.authorId ?? ''}`, query: expression }
  const cursor = input.cursor ? decodeMessageSearchCursor(input.cursor, scope) : null
  if (input.cursor && !cursor) fail(400, 'bad_request', 'Invalid search cursor')

  const canSeeAgentDms = member.isOwner || member.user.kind === 'agent' || hasPermission(member.perms, Permission.useAgents)
  const result = await env.DB.prepare(SEARCH_SERVER_MESSAGES_SQL).bind(
    expression,
    member.user.id,
    canSeeAgentDms ? 1 : 0,
    input.channelId ?? null,
    input.authorId ?? null,
    cursor ? 1 : 0,
    cursor?.createdAt ?? '',
    cursor?.id ?? '',
    pageSize + 1,
    member.authorization.delegation?.by ?? null,
  ).all<SearchRow>()
  const rows = result.results ?? []
  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows

  // The shared guard stays authoritative; threads inherit their root's access.
  const roots = new Map<string, Promise<ServerChannelAccess | null>>()
  for (const row of page) {
    if (!roots.has(row.rootId)) {
      roots.set(row.rootId, requireChannelAccessForMember(env, member, row.rootId).catch((error: unknown) => {
        if (error instanceof Error && 'statusCode' in error && error.statusCode === 404) return null
        throw error
      }))
    }
  }
  const access = new Map(await Promise.all([...roots].map(async ([id, pending]) => [id, await pending] as const)))
  const hits = page.flatMap((row) => {
    const root = access.get(row.rootId)
    return root ? [searchHit(row, root, member.user.id)] : []
  })
  const last = page.at(-1)
  return {
    hits,
    nextCursor: hasMore && last ? encodeMessageSearchCursor({ createdAt: last.createdAt, id: last.id }, scope) : null,
  }
}
