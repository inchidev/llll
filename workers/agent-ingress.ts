import { isDmType } from '../shared/dm'
import { hasPermission, Permission } from '../shared/permissions'
import { asRpc, type L4Env } from './env'

type AgentIngressMessage = {
  messageId: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  mentionIds: string[]
  mode?: 'queue' | 'steer'
  /** An edit addresses only newly mentioned Agents; a DM's Agent already received the send. */
  edit?: boolean
}

type AgentReceiveMessage = Omit<AgentIngressMessage, 'mentionIds' | 'edit'> & {
  hasImages: boolean
}

/** Starts one durable reply workflow per addressed agent. D1 remains the routing authority. */
export async function signalAgentsForMessage(env: L4Env, message: AgentIngressMessage): Promise<void> {
  if (!env.AGENT_DO) return
  const image = await env.DB.prepare(
    "SELECT id FROM attachments WHERE message_id = ? AND content_type LIKE 'image/%' LIMIT 1",
  ).bind(message.messageId).first<{ id: string }>()
  const hasImages = Boolean(image)
  if (!message.content.trim() && !hasImages) return
  const actor = await env.DB.prepare(
    `SELECT r.permissions_bitmask as permissions, w.owner_id as ownerId
     FROM users u
     JOIN roles r ON r.id = u.role_id
     CROSS JOIN server w
     WHERE u.id = ? AND u.status = 'active'`,
  ).bind(message.authorId).first<{ permissions: number; ownerId: string }>()
  if (!actor || (actor.ownerId !== message.authorId && !hasPermission(actor.permissions, Permission.useAgents))) return

  const channel = await env.DB.prepare(
    'SELECT type, visibility, parent_id as parentId FROM channels WHERE id = ?',
  ).bind(message.channelId).first<{ type: string; visibility: string; parentId: string | null }>()
  if (!channel) return

  const accessChannelId = channel.type === 'thread' && channel.parentId ? channel.parentId : message.channelId
  const accessChannel = accessChannelId === message.channelId
    ? channel
    : await env.DB.prepare(
        'SELECT type, visibility, parent_id as parentId FROM channels WHERE id = ?',
      ).bind(accessChannelId).first<{ type: string; visibility: string; parentId: string | null }>()
  if (!accessChannel) return

  const candidates = new Set(message.mentionIds)
  if (isDmType(accessChannel.type) && !message.edit) {
    const rows = await env.DB.prepare(
      `SELECT u.id
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN agents a ON a.user_id = u.id
       WHERE cm.channel_id = ? AND u.kind = 'agent' AND u.status = 'active' AND a.status = 'active'`,
    ).bind(accessChannelId).all<{ id: string }>()
    for (const row of rows.results ?? []) candidates.add(row.id)
  }
  if (!candidates.size) return

  const ids = [...candidates]
  const placeholders = ids.map(() => '?').join(',')
  const accessClause = accessChannel.visibility === 'private'
    ? `AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ? AND cm.user_id = u.id)`
    : ''
  const rows = await env.DB.prepare(
    `SELECT u.id
     FROM users u JOIN agents a ON a.user_id = u.id
     WHERE u.id IN (${placeholders}) AND u.kind = 'agent' AND u.status = 'active' AND a.status = 'active'
     ${accessClause}`,
  ).bind(...ids, ...(accessChannel.visibility === 'private' ? [accessChannelId] : [])).all<{ id: string }>()

  await Promise.allSettled((rows.results ?? []).map(async ({ id }) => {
    const stub = asRpc<{
      receiveMessage: (input: AgentReceiveMessage) => Promise<string>
    }>(env.AGENT_DO.getByName(`agent:${id}`))
    try { await stub.receiveMessage({
      messageId: message.messageId,
      channelId: message.channelId,
      authorId: message.authorId,
      authorName: message.authorName,
      content: message.content,
      hasImages,
      mode: message.mode,
    }) } catch {
      // Only a coarse notice is shared: admission errors may include private scope details.
      if (env.CHANNEL_DO) await asRpc<{ fanout: (event: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${message.channelId}`)).fanout({
        t: 'agent.start_failed', agentId: id, initiatedBy: message.authorId,
        message: 'Agent could not start. Check its role, project access and model configuration.',
      })
    }
  }))
}
