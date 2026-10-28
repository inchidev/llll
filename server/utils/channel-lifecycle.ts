import type { ServerChannelsChangedEvent } from '../../shared/server-realtime'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { asRpc, fail } from './cf'
import type { ServerChannelAccess } from './channel-access'
import { revalidateLiveRooms } from './live'
import { writeAudit } from './messages'

type ChannelRef = { id: string, type: string, visibility: string, parentId: string | null }

/** Root text channels listed in Chat: not archived, and not a mailbox or task discussion sharing the table. */
const ACTIVE_CHAT_CHANNEL = `c.type = 'text' AND c.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = c.id)`

/** Active Chat channels; the last one can be neither deleted nor archived. */
export async function chatChannelCount(env: L4Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels c WHERE ${ACTIVE_CHAT_CHANNEL}`).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function isChatChannel(env: L4Env, channel: ChannelRef): Promise<boolean> {
  if (channel.type !== 'text') return false
  const hidden = await env.DB.prepare(`SELECT 1 AS hidden WHERE EXISTS (SELECT 1 FROM email_mailboxes WHERE channel_id = ?)
    OR EXISTS (SELECT 1 FROM tasks WHERE discussion_channel_id = ?)`).bind(channel.id, channel.id).first()
  return !hidden
}

/** The conversation and, for a channel, its Threads: everything a delete removes. */
export async function conversationTree(env: L4Env, channel: ChannelRef): Promise<string[]> {
  if (channel.type === 'thread') return [channel.id]
  const threads = await env.DB.prepare('SELECT id FROM channels WHERE parent_id = ?').bind(channel.id).all<{ id: string }>()
  return [channel.id, ...(threads.results ?? []).map(row => row.id)]
}

/**
 * Runs, Agent sessions, Schedules and coding work keep a reference to their conversation.
 * Runs are private audit records, so a conversation that has them is kept rather than
 * deleted together with its history.
 */
export async function deletionBlocker(env: L4Env, id: string): Promise<string | null> {
  // A Thread has no children, so the same scope covers a channel with its Threads or one Thread.
  const scope = '(SELECT id FROM channels WHERE id = ? OR parent_id = ?)'
  const row = await env.DB.prepare(`SELECT
      EXISTS (SELECT 1 FROM agent_runs WHERE channel_id IN ${scope}
        OR source_message_id IN (SELECT id FROM messages WHERE channel_id IN ${scope})) AS runs,
      EXISTS (SELECT 1 FROM agent_sessions WHERE channel_id IN ${scope}) AS sessions,
      EXISTS (SELECT 1 FROM agent_schedules WHERE channel_id IN ${scope}) AS schedules,
      EXISTS (SELECT 1 FROM factory_workspaces WHERE channel_id IN ${scope}) AS coding`)
    .bind(...Array(10).fill(id)).first<{ runs: number, sessions: number, schedules: number, coding: number }>()
  if (row?.runs || row?.sessions || row?.coding) return 'This conversation has Agent Runs, which are kept as audit records, so it cannot be deleted.'
  if (row?.schedules) return 'This conversation has Schedules. Delete them before deleting the conversation.'
  return null
}

/** Members who may see a channel's existence: everyone for server channels, otherwise its members. */
export async function channelAudience(env: L4Env, rootId: string): Promise<string[] | undefined> {
  const root = await env.DB.prepare('SELECT visibility, type FROM channels WHERE id = ?').bind(rootId).first<{ visibility: string, type: string }>()
  if (!root || (root.type !== 'dm' && root.visibility === 'server')) return undefined
  const rows = await env.DB.prepare('SELECT user_id AS id FROM channel_members WHERE channel_id = ?').bind(rootId).all<{ id: string }>()
  return (rows.results ?? []).map(row => row.id)
}

/** Best effort: D1 is already committed, and clients also refetch on focus and reconnect. */
export async function signalChannelsChanged(
  env: L4Env,
  serverId: string,
  change: { deletedIds?: string[], parentIds?: string[], updatedIds?: string[] } = {},
  recipientIds?: string[],
): Promise<void> {
  const event: ServerChannelsChangedEvent = {
    t: 'channels.changed',
    serverId,
    deletedIds: change.deletedIds ?? [],
    parentIds: change.parentIds ?? [],
    ...(change.updatedIds?.length ? { updatedIds: change.updatedIds } : {}),
  }
  try {
    await asRpc<{ notifyChannelsChanged: (event: ServerChannelsChangedEvent, recipientIds?: string[]) => Promise<void> }>(
      env.SERVER_DO.getByName(`server:${serverId}`),
    ).notifyChannelsChanged(event, recipientIds)
  }
  catch { /* realtime is advisory */ }
}

/**
 * Archive or restore a Chat channel. Its Threads follow it. Members with Manage channels
 * may do this; a private channel follows its visibility rule, so only its creator can.
 * Archiving cancels the channel's queued and running Agent Runs, whose replies could no
 * longer be posted, and ends its Live room. Schedules that post there are blocked when
 * they next fire and can be resumed after a restore.
 */
export async function setChannelArchived(
  env: L4Env,
  access: ServerChannelAccess,
  archived: boolean,
  schedule: (promise: Promise<unknown>) => void,
): Promise<{ changed: boolean, cancelledRuns: number }> {
  const channel = access.channel
  if (channel.type === 'dm') fail(400, 'invalid_channel', 'Direct messages cannot be archived')
  if (channel.type === 'thread') fail(400, 'invalid_channel', 'Threads follow their channel; archive the channel instead')
  if (!await isChatChannel(env, channel)) fail(400, 'invalid_channel', 'Only Chat channels can be archived')
  if (channel.visibility === 'private') {
    if (!channel.createdBy) fail(403, 'forbidden', 'Assign a channel creator before archiving or restoring this channel')
    if (channel.createdBy !== access.user.id) fail(403, 'forbidden', 'Only the channel creator can archive or restore this channel')
  }
  const at = nowIso()
  const changed = archived
    // The last-channel rule is part of the write, so two concurrent archives cannot both pass it.
    ? await env.DB.prepare(`UPDATE channels SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM channels c WHERE ${ACTIVE_CHAT_CHANNEL} AND c.id <> ?) RETURNING id`)
      .bind(at, access.user.id, at, channel.id, channel.id).first()
    : await env.DB.prepare('UPDATE channels SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL RETURNING id')
      .bind(at, channel.id).first()
  if (!changed) {
    const current = await env.DB.prepare('SELECT archived_at AS archivedAt FROM channels WHERE id = ?').bind(channel.id).first<{ archivedAt: string | null }>()
    if (Boolean(current?.archivedAt) === archived) return { changed: false, cancelledRuns: 0 }
    fail(400, 'last_channel', 'Cannot archive the last channel')
  }
  const tree = await conversationTree(env, channel)
  let cancelledRuns = 0
  if (archived) {
    cancelledRuns = await cancelConversationRuns(env, channel.id)
    // An archived channel's Live room ends; its participants leave the media session.
    schedule(revalidateLiveRooms(env, [channel.id]))
  }
  await writeAudit(env, {
    serverId: access.serverId,
    actorId: access.user.id,
    action: archived ? 'channel.archive' : 'channel.restore',
    targetType: 'channel',
    targetId: channel.id,
    ...(archived ? { meta: { cancelledRuns } } : {}),
  })
  schedule(signalChannelsChanged(env, access.serverId, { updatedIds: tree }, await channelAudience(env, channel.id)))
  return { changed: true, cancelledRuns }
}

/**
 * Runs end through their own Durable Object so status, budget and report settle normally.
 * Every Run step rechecks Send messages in its conversation, which an archived channel
 * refuses, so a missed cancel still cannot post.
 */
async function cancelConversationRuns(env: L4Env, channelId: string): Promise<number> {
  if (!env.AGENT_RUN_DO) return 0
  const runs = await env.DB.prepare(`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')
    AND channel_id IN (SELECT id FROM channels WHERE id = ? OR parent_id = ?)`).bind(channelId, channelId).all<{ id: string }>()
  let cancelled = 0
  for (const run of runs.results ?? []) {
    try {
      await asRpc<{ cancel: () => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${run.id}`)).cancel()
      cancelled += 1
    }
    catch { /* The Run's own authorization check fences it. */ }
  }
  return cancelled
}
