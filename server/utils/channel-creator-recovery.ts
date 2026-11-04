import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { spaceSql } from '../../shared/spaces'
import { newId, nowIso } from '../../shared/ids'
import { fail } from './cf'

const eligible = `c.type='text' AND c.visibility='private' AND c.created_by IS NULL
  AND NOT EXISTS(SELECT 1 FROM tasks WHERE discussion_channel_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM email_mailboxes WHERE channel_id=c.id)`
type Spaces = Pick<AuthorizationContext, 'spaces'>
const inSpaces = (auth: Spaces) => `c.space_id IN (${spaceSql(auth)})`

export async function orphanedPrivateChannels(env: L4Env, page: number, auth: Spaces = {}) {
  const count = await env.DB.prepare(`SELECT count(*) AS total FROM channels c WHERE ${eligible} AND ${inSpaces(auth)}`).first<{ total: number }>()
  const rows = await env.DB.prepare(`SELECT c.id,c.name FROM channels c WHERE ${eligible} AND ${inSpaces(auth)} ORDER BY c.name,c.id LIMIT 25 OFFSET ?`).bind((page - 1) * 25).all<{ id: string; name: string }>()
  return { channels: rows.results, total: count?.total ?? 0 }
}

export async function creatorCandidates(env: L4Env, channelId: string, search: string, auth: Spaces = {}) {
  const channel = await env.DB.prepare(`SELECT c.id FROM channels c WHERE c.id=? AND ${eligible} AND ${inSpaces(auth)}`).bind(channelId).first()
  if (!channel) fail(409, 'creator_recorded', 'This channel does not need creator recovery')
  const rows = await env.DB.prepare(`SELECT u.id,u.display_name AS label FROM users u JOIN channel_members cm ON cm.user_id=u.id JOIN channels c ON c.id=cm.channel_id
    JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=c.space_id
    WHERE cm.channel_id=? AND u.status='active' AND u.kind='human' AND instr(lower(u.display_name),?)>0
    ORDER BY u.display_name,u.id LIMIT 51`).bind(channelId, search.toLowerCase()).all<{ id: string; label: string }>()
  return { members: rows.results.slice(0, 50), hasMore: rows.results.length > 50 }
}

/** The audit receipt and assignment commit together. This grants no membership. */
export async function assignMissingChannelCreator(env: L4Env, serverId: string, actorId: string, channelId: string, userId: string, auth: Spaces = {}) {
  const auditId = newId()
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO audit_log(id,actor_id,action,target_type,target_id,meta_json,created_at)
      SELECT ?,?,'channel.creator.assign','channel',c.id,?,? FROM channels c WHERE c.id=? AND ${eligible} AND ${inSpaces(auth)}
      AND EXISTS(SELECT 1 FROM server s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND s.owner_id=? AND u.status='active')
      AND EXISTS(SELECT 1 FROM channel_members cm JOIN users u ON u.id=cm.user_id JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=c.space_id WHERE cm.channel_id=c.id AND u.id=? AND u.status='active' AND u.kind='human')
      RETURNING id`).bind(auditId, actorId, JSON.stringify({ userId }), nowIso(), channelId, serverId, actorId, userId),
    env.DB.prepare('UPDATE channels SET created_by=? WHERE id=? AND created_by IS NULL AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)').bind(userId, channelId, auditId),
  ])
  if (!result[0]?.results?.length) fail(409, 'creator_not_assigned', 'Choose a current human participant in a private channel without a creator')
  return { createdBy: userId }
}
