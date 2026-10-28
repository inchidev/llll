import type { ServerChannelsChangedEvent } from '../../shared/server-realtime'
import type { L4Env } from '../../workers/env'
import { asRpc } from './cf'

type ChannelRef = { id: string, type: string, visibility: string, parentId: string | null }

/** Root text channels that appear in Chat; mailboxes and task discussions share the table but not the list. */
export async function chatChannelCount(env: L4Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels c WHERE c.type = 'text'
    AND NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = c.id)`).first<{ n: number }>()
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
  change: { deletedIds?: string[], parentIds?: string[] } = {},
  recipientIds?: string[],
): Promise<void> {
  const event: ServerChannelsChangedEvent = {
    t: 'channels.changed',
    serverId,
    deletedIds: change.deletedIds ?? [],
    parentIds: change.parentIds ?? [],
  }
  try {
    await asRpc<{ notifyChannelsChanged: (event: ServerChannelsChangedEvent, recipientIds?: string[]) => Promise<void> }>(
      env.SERVER_DO.getByName(`server:${serverId}`),
    ).notifyChannelsChanged(event, recipientIds)
  }
  catch { /* realtime is advisory */ }
}
