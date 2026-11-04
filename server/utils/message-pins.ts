import type { H3Event } from 'h3'
import type { ChannelAccess } from './guards'
import type { L4Env } from '../../workers/env'
import type { MessagePinDTO } from '../../shared/types'
import { hasPermission, Permission } from '../../shared/permissions'
import { asRpc, fail } from './cf'
import { requireChannelAccess } from './guards'
import { requireActiveChannel } from './channel-access'

type PinAccess = Pick<ChannelAccess, 'accessRootType' | 'frozen' | 'perms'>

export const INSERT_MESSAGE_PIN_SQL = `
  INSERT OR IGNORE INTO message_pins (message_id, pinned_by, pinned_at)
  VALUES (?, ?, ?)
`

export function canManageMessagePins(access: PinAccess): boolean {
  if (access.accessRootType === 'dm') {
    return !access.frozen && hasPermission(access.perms, Permission.sendMessages)
  }
  return hasPermission(access.perms, Permission.manageChannels)
}

export async function requireMessagePinAccess(event: H3Event, channelId: string): Promise<ChannelAccess> {
  const access = await requireChannelAccess(event, channelId)
  requireActiveChannel(access)
  if (!canManageMessagePins(access)) fail(403, 'forbidden', 'Missing permission')
  return access
}

export async function loadMessagePin(env: L4Env, messageId: string): Promise<MessagePinDTO | null> {
  const row = await env.DB.prepare(
    `SELECT p.pinned_at, u.id, u.kind, u.display_name, u.avatar_r2_key
     FROM message_pins p
     JOIN users u ON u.id = p.pinned_by
     WHERE p.message_id = ?`,
  ).bind(messageId).first<{
    pinned_at: string
    id: string
    kind: 'human' | 'agent'
    display_name: string
    avatar_r2_key: string | null
  }>()
  if (!row) return null
  return {
    pinnedBy: {
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      avatarR2Key: row.avatar_r2_key,
    },
    pinnedAt: row.pinned_at,
  }
}

export async function fanoutMessagePin(
  env: L4Env,
  channelId: string,
  messageId: string,
  pin: MessagePinDTO | null,
): Promise<void> {
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`))
    await stub.fanout({ t: 'pin', messageId, pin })
  }
  catch { /* local without DO */ }
}
