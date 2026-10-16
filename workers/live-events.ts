import { channelPath } from '../shared/paths'
import { liveNotificationTitle } from '../shared/live'
import type { LiveState, PublicUser } from '../shared/types'
import type { WorkspaceLiveChangedEvent } from '../shared/workspace-realtime'
import { WORKSPACE_ID } from '../shared/ids'
import { asRpc, type L4Env } from './env'

type LiveChannel = {
  id: string
  name: string
  type: string
  visibility: string
}

/** Everyone who can open the conversation sees its Live room. Agents never join one. */
async function audience(env: L4Env, channelId: string) {
  const channel = await env.DB.prepare(
    'SELECT id, name, type, visibility FROM channels WHERE id = ?',
  ).bind(channelId).first<LiveChannel>()
  if (!channel) return null
  const restricted = channel.type === 'dm' || channel.visibility === 'private'
  const rows = restricted
    ? await env.DB.prepare(
        `SELECT u.id
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = ? AND u.status = 'active' AND u.kind = 'human'
         ORDER BY u.id`,
      ).bind(channel.id).all<{ id: string }>()
    : await env.DB.prepare(
        `SELECT id FROM users WHERE status = 'active' AND kind = 'human' ORDER BY id`,
      ).all<{ id: string }>()
  return { channel, recipientIds: (rows.results ?? []).map(row => row.id) }
}

/**
 * Tell the workspace a Live room changed. `started` carries the person who
 * started it: their start rings the other side of a Call and announces a Live
 * session to everyone else once.
 */
export async function signalLiveChanged(
  env: L4Env,
  channelId: string,
  live: LiveState,
  opts: { started?: PublicUser, outcome?: WorkspaceLiveChangedEvent['outcome'] } = {},
): Promise<void> {
  const target = await audience(env, channelId)
  if (!target) return
  const starterId = opts.started?.id
  const recipientIds = starterId ? target.recipientIds.filter(id => id !== starterId) : target.recipientIds
  if (!recipientIds.length) return
  const event: WorkspaceLiveChangedEvent = {
    t: 'live.changed',
    channelId,
    live,
    ring: Boolean(opts.started && live.kind === 'call'),
    ...(opts.outcome ? { outcome: opts.outcome } : {}),
    ...(opts.started
      ? {
          notification: {
            title: liveNotificationTitle(live.kind, opts.started.displayName, target.channel.type === 'dm' ? null : target.channel.name),
            body: live.kind === 'call' ? 'Tap to answer' : 'Tap to join',
            url: channelPath(channelId),
          },
        }
      : {}),
  }
  const stub = asRpc<{
    notifyLiveChanged: (event: WorkspaceLiveChangedEvent, recipientIds: string[]) => Promise<void>
  }>(env.WORKSPACE_DO.getByName(`workspace:${WORKSPACE_ID}`))
  await stub.notifyLiveChanged(event, recipientIds)
}
