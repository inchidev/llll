import { bytesToHex } from '@noble/hashes/utils.js'
import type { H3Event } from 'h3'
import { newId, nowIso } from '../../shared/ids'
import { isRecordingKeyRoute, RECORDING_UPLOAD_PATH, type CreatedRecordingKeyDTO, type RecordingKeyDTO } from '../../shared/task-recordings'
import type { L4Env } from '../../workers/env'
import { cf, fail } from './cf'

/** Its own prefix, because `/mcp` only reads `dfmcp_`: a device key can't open anything there. */
const KEY_PREFIX = 'l4rec_'
const KEY_SHAPE = /^l4rec_[0-9a-f]{64}$/u
const KEY_SCOPE = 'recordings:upload'

export type RecordingKey = { id: string; userId: string; spaceId: string; boardId: string | null }
type KeyedContext = { recordingKey?: RecordingKey }

async function digest(token: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
}

export const recordingKeyOf = (event: H3Event) => (event.context as KeyedContext).recordingKey ?? null

/**
 * The key in a link to a device key's routes. Undefined for any other request, so nothing else ever
 * reads a key, and null when the link holds one that doesn't work.
 */
export async function recordingKeyRequest(event: H3Event): Promise<RecordingKey | null | undefined> {
  const [path, query] = (event.path || '').split('?')
  if (!isRecordingKeyRoute(event.method.toUpperCase(), path!)) return undefined
  const token = new URLSearchParams(query).get('key') ?? ''
  if (!KEY_SHAPE.test(token)) return null
  const { env, waitUntil } = cf(event)
  const key = await env.DB.prepare(`SELECT id, subject_id AS userId, space_id AS spaceId, board_id AS boardId FROM mcp_access_tokens
    WHERE token_hash = ? AND revoked_at IS NULL AND space_id IS NOT NULL`).bind(await digest(token)).first<RecordingKey>()
  if (!key) return null
  ;(event.context as KeyedContext).recordingKey = key
  waitUntil(env.DB.prepare('UPDATE mcp_access_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), key.id).run())
  return key
}

const KEY_SELECT = `SELECT t.id, t.name, t.token_prefix AS tokenPrefix, t.space_id AS spaceId, s.name AS spaceName, b.name AS boardName, t.last_used_at AS lastUsedAt, t.created_at AS createdAt
  FROM mcp_access_tokens t JOIN spaces s ON s.id = t.space_id LEFT JOIN task_boards b ON b.id = t.board_id AND b.archived_at IS NULL`

export async function listRecordingKeys(env: L4Env, userId: string): Promise<RecordingKeyDTO[]> {
  return (await env.DB.prepare(`${KEY_SELECT} WHERE t.created_by = ? AND t.space_id IS NOT NULL AND t.revoked_at IS NULL ORDER BY t.created_at DESC`).bind(userId).all<RecordingKeyDTO>()).results ?? []
}

/** Only its digest is kept: this is the one time anyone sees the key. */
export async function createRecordingKey(env: L4Env, userId: string, spaceId: string, name: string): Promise<CreatedRecordingKeyDTO> {
  const token = `${KEY_PREFIX}${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`
  const id = newId(), now = nowIso()
  await env.DB.prepare(`INSERT INTO mcp_access_tokens(id,name,token_hash,token_prefix,scopes_json,subject_id,created_by,space_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, name, await digest(token), token.slice(0, 14), JSON.stringify([KEY_SCOPE]), userId, userId, spaceId, now, now).run()
  return { ...(await env.DB.prepare(`${KEY_SELECT} WHERE t.id = ?`).bind(id).first<RecordingKeyDTO>())!, token }
}

/** The person's own live key, or a 404 like any other that isn't theirs. */
async function requireOwnKey(env: L4Env, userId: string, id: string) {
  const key = await env.DB.prepare('SELECT id, space_id AS spaceId FROM mcp_access_tokens WHERE id = ? AND created_by = ? AND space_id IS NOT NULL AND revoked_at IS NULL').bind(id, userId).first<{ id: string; spaceId: string }>()
  if (!key) fail(404, 'not_found', 'Key not found')
  return key
}

export async function revokeRecordingKey(env: L4Env, userId: string, id: string) {
  await requireOwnKey(env, userId, id)
  const now = nowIso()
  await env.DB.prepare('UPDATE mcp_access_tokens SET revoked_at = ?, updated_at = ? WHERE id = ?').bind(now, now, id).run()
}

/** Remembers where this device's recordings go. The upload checks again that the person can still add Tasks there. */
export async function rememberRecordingBoard(env: L4Env, userId: string, id: string, boardId: string) {
  const key = await requireOwnKey(env, userId, id)
  const board = await env.DB.prepare(`SELECT b.id FROM task_boards b JOIN space_members m ON m.space_id = b.space_id AND m.user_id = ? WHERE b.id = ? AND b.space_id = ? AND b.archived_at IS NULL`).bind(userId, boardId, key.spaceId).first()
  if (!board) fail(404, 'not_found', 'Board not found')
  await env.DB.prepare('UPDATE mcp_access_tokens SET board_id = ?, updated_at = ? WHERE id = ?').bind(boardId, nowIso(), id).run()
}

/**
 * The iPhone Shortcut opens whatever comes back, so a refused upload answers with a page that
 * explains it. The page takes a code, never words from the request.
 */
export function recordingUploadProblem(event: H3Event, error: unknown): string | null {
  if ((event.path || '').split('?')[0] !== RECORDING_UPLOAD_PATH || event.method.toUpperCase() !== 'POST') return null
  const failure = error as { statusCode?: number; data?: { error?: { code?: string } } }
  if (!failure?.statusCode) console.error('recording.upload_failed', { message: error instanceof Error ? error.message : 'unknown' })
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return `${getRequestURL(event).origin}/recording-problem?why=${encodeURIComponent(failure?.data?.error?.code || (failure?.statusCode === 401 ? 'unauthorized' : 'failed'))}`
}
