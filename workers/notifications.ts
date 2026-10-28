import { filterLiveRecipients } from './live-audience'
import type { LiveKind, PublicUser } from '../shared/types'
import { liveNotificationTitle } from '../shared/live'
import { channelPath, mailPath } from '../shared/paths'
import { Permission } from '../shared/permissions'
import { notificationPreview, type NotificationKind, type PushNotificationPayload } from '../shared/notifications'
import type { L4Env } from './env'
import { asRpc } from './env'

type ChannelRow = {
  id: string
  name: string
  type: string
  visibility: string
  parent_id: string | null
}

type NotificationSpec = {
  eventId: string
  kind: NotificationKind
  channelId: string
  recipientIds: string[]
  payload: PushNotificationPayload
}

type NotificationMessage = {
  id: string
  channelId: string
  author: PublicUser
  content: string
  mentions: string[]
  /** Members reached through a role mention, already limited to people who can read the conversation. */
  roleMentions?: string[]
  attachmentCount: number
  /** An edit notifies only the Members it newly mentions; DM participants heard the send. */
  edit?: boolean
}

async function channelAndRoot(env: L4Env, channelId: string): Promise<{ channel: ChannelRow; root: ChannelRow } | null> {
  const channel = await env.DB.prepare(
    'SELECT id, name, type, visibility, parent_id FROM channels WHERE id = ?',
  ).bind(channelId).first<ChannelRow>()
  if (!channel) return null
  if (channel.type !== 'thread' || !channel.parent_id) return { channel, root: channel }
  const root = await env.DB.prepare(
    'SELECT id, name, type, visibility, parent_id FROM channels WHERE id = ?',
  ).bind(channel.parent_id).first<ChannelRow>()
  return root ? { channel, root } : null
}

async function activeDmRecipients(env: L4Env, channelId: string, actorId?: string): Promise<string[]> {
  const rows = actorId
    ? await env.DB.prepare(
        `SELECT cm.user_id
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id AND u.status = 'active'
         WHERE cm.channel_id = ? AND cm.user_id <> ?`,
      ).bind(channelId, actorId).all<{ user_id: string }>()
    : await env.DB.prepare(
        `SELECT cm.user_id
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id AND u.status = 'active'
         WHERE cm.channel_id = ?`,
      ).bind(channelId).all<{ user_id: string }>()
  return (rows.results ?? []).map(row => row.user_id)
}

async function accessibleMentions(env: L4Env, root: ChannelRow, actorId: string, mentions: string[]): Promise<string[]> {
  const candidates = [...new Set(mentions)].filter(id => id !== actorId)
  if (!candidates.length) return []
  const placeholders = candidates.map(() => '?').join(',')
  if (root.visibility === 'private') {
    const rows = await env.DB.prepare(
      `SELECT u.id
       FROM users u
       JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = ?
       WHERE u.id IN (${placeholders}) AND u.status = 'active'`,
    ).bind(root.id, ...candidates).all<{ id: string }>()
    return (rows.results ?? []).map(row => row.id)
  }
  const rows = await env.DB.prepare(
    `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`,
  ).bind(...candidates).all<{ id: string }>()
  const people = (rows.results ?? []).map(row => row.id)
  const [mailbox, task] = await Promise.all([
    env.DB.prepare('SELECT enabled FROM email_mailboxes WHERE channel_id = ?').bind(root.id).first<{ enabled: number }>(),
    env.DB.prepare('SELECT id, board_id AS boardId FROM tasks WHERE discussion_channel_id = ?').bind(root.id).first<{ id: string; boardId: string }>(),
  ])
  if (!mailbox && !task) return people
  if (!people.length || (mailbox && !mailbox.enabled)) return []
  // Mailboxes and Task discussions have their own grants, and a push carries the message
  // preview. Mailboxes use the guard's rule; a discussion stays with people who certainly
  // read its Task (Owner, creator, assignee, or a Role reading every Board or this one).
  const access = mailbox
    ? `EXISTS (SELECT 1 FROM email_mailbox_access a WHERE a.channel_id = ?1 AND a.user_id = u.id)
       AND (u.id = s.owner_id OR (r.permissions_bitmask & ${Permission.readMail | Permission.sendMail}) != 0)`
    : `(u.id = s.owner_id OR u.id IN (SELECT created_by FROM tasks WHERE id = ?1) OR u.id IN (SELECT assignee_id FROM tasks WHERE id = ?1)
       OR ((r.permissions_bitmask & ${Permission.readTasks | Permission.writeTasks | Permission.manageTasks}) != 0
         AND (json_extract(r.resource_access_json, '$.boards') IS NULL
           OR EXISTS (SELECT 1 FROM json_each(r.resource_access_json, '$.boards') b WHERE b.value IN ('*', ?2)))))`
  const allowed = await env.DB.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id CROSS JOIN server s
    WHERE u.id IN (SELECT value FROM json_each(?${mailbox ? '2' : '3'})) AND ${access}`)
    .bind(...(mailbox ? [root.id, JSON.stringify(people)] : [task!.id, task!.boardId, JSON.stringify(people)])).all<{ id: string }>()
  return (allowed.results ?? []).map(row => row.id)
}

/** People who can open the conversation. Agents never join a Live room, so they are not told about one. */
async function liveRecipients(env: L4Env, channel: ChannelRow, actorId: string): Promise<string[]> {
  const rows = channel.type === 'dm' || channel.visibility === 'private'
    ? await env.DB.prepare(
        `SELECT cm.user_id AS id
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id AND u.status = 'active' AND u.kind = 'human'
         WHERE cm.channel_id = ? AND cm.user_id <> ?`,
      ).bind(channel.id, actorId).all<{ id: string }>()
    : await env.DB.prepare(
        `SELECT id FROM users WHERE status = 'active' AND kind = 'human' AND id <> ?`,
      ).bind(actorId).all<{ id: string }>()
  return filterLiveRecipients(env, channel.id, (rows.results ?? []).map(row => row.id))
}

function outboxStatement(env: L4Env, spec: NotificationSpec): D1PreparedStatement | null {
  const recipientIds = [...new Set(spec.recipientIds)]
  if (!recipientIds.length) return null
  const now = new Date().toISOString()
  return env.DB.prepare(
    `INSERT OR IGNORE INTO notification_outbox (
       event_id, subscription_id, recipient_id, kind, channel_id, payload_json,
       attempts, available_at, lease_token, lease_until, delivered_at, failed_at, last_error, created_at
     )
     SELECT ?, ps.id, ps.user_id, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, ?
     FROM push_subscriptions ps
     WHERE ps.user_id IN (SELECT value FROM json_each(?))`,
  ).bind(
    spec.eventId,
    spec.kind,
    spec.channelId,
    JSON.stringify(spec.payload),
    now,
    now,
    // One JSON array keeps a role mention's hundreds of recipients under D1's bound-parameter limit.
    JSON.stringify(recipientIds),
  )
}

export async function messageNotificationStatement(env: L4Env, message: NotificationMessage): Promise<D1PreparedStatement | null> {
  const channels = await channelAndRoot(env, message.channelId)
  if (!channels) return null
  const { channel, root } = channels
  const dm = root.type === 'dm'
  if (dm && message.edit) return null
  const recipientIds = dm
    ? await activeDmRecipients(env, root.id, message.author.id)
    : [...await accessibleMentions(env, root, message.author.id, message.mentions), ...(message.roleMentions ?? [])]
  if (!recipientIds.length) return null
  const kind: NotificationKind = dm ? 'dm_message' : 'mention'
  const title = dm ? message.author.displayName : `${message.author.displayName} mentioned you in #${root.name}`
  const url = channel.type === 'thread' ? channelPath(root.id, channel.id) : channelPath(channel.id)
  return outboxStatement(env, {
    eventId: `message:${message.id}`,
    kind,
    channelId: message.channelId,
    recipientIds,
    payload: {
      title,
      body: notificationPreview(message.content, message.attachmentCount),
      tag: `message:${message.id}`,
      url,
      icon: '/android-chrome-192x192.png',
      badge: '/favicon-32x32.png',
    },
  })
}

/** A reminder is authored by the person it reminds, so message rules would skip them. Shares the message's event id. */
export async function reminderNotificationStatement(env: L4Env, message: NotificationMessage, recipientId: string): Promise<D1PreparedStatement | null> {
  const channels = await channelAndRoot(env, message.channelId)
  if (!channels) return null
  const { channel, root } = channels
  return outboxStatement(env, {
    eventId: `message:${message.id}`,
    kind: 'mention',
    channelId: message.channelId,
    recipientIds: [recipientId],
    payload: {
      title: root.type === 'dm' ? 'Reminder' : `Reminder in #${root.name}`,
      body: notificationPreview(message.content, message.attachmentCount),
      tag: `message:${message.id}`,
      url: channel.type === 'thread' ? channelPath(root.id, channel.id) : channelPath(channel.id),
      icon: '/android-chrome-192x192.png',
      badge: '/favicon-32x32.png',
    },
  })
}

/** Push for a Live room that just went live: a ringing Call in a 1:1 DM, a joinable session elsewhere. */
export async function liveNotificationStatement(
  env: L4Env,
  channelId: string,
  meetingId: string,
  actor: PublicUser,
  kind: LiveKind,
): Promise<D1PreparedStatement | null> {
  const channels = await channelAndRoot(env, channelId)
  if (!channels || channels.channel.type === 'thread') return null
  const recipientIds = await liveRecipients(env, channels.channel, actor.id)
  return outboxStatement(env, {
    eventId: `live:${meetingId}`,
    kind: 'live_started',
    channelId,
    recipientIds,
    payload: {
      title: liveNotificationTitle(kind, actor.displayName, channels.channel.type === 'dm' ? null : channels.channel.name),
      body: kind === 'call' ? 'Tap to answer' : 'Tap to join',
      tag: `live:${meetingId}`,
      url: channelPath(channelId),
      icon: '/android-chrome-192x192.png',
      badge: '/favicon-32x32.png',
    },
  })
}

/**
 * People who may read a mailbox now: a mailbox grant plus Read or Send email (or Owner).
 * Delivery checks this again, so a grant removed while the push waits stops it.
 */
export const MAILBOX_READERS_SQL = `SELECT a.user_id AS id FROM email_mailbox_access a
  JOIN users u ON u.id = a.user_id AND u.status = 'active' AND u.kind = 'human'
  JOIN roles r ON r.id = u.role_id CROSS JOIN server s
  WHERE a.channel_id = ? AND (u.id = s.owner_id OR (r.permissions_bitmask & ${Permission.readMail | Permission.sendMail}) != 0)`

type InboundMail = { messageId: string; mailboxId: string; threadId: string; subject: string; fromName: string | null; fromAddress: string; content: string }

/** Push for an email that just arrived, to everyone who can read its mailbox. */
export async function mailNotificationStatement(env: L4Env, mail: InboundMail): Promise<D1PreparedStatement | null> {
  const [readers, mailbox] = await Promise.all([
    env.DB.prepare(MAILBOX_READERS_SQL).bind(mail.mailboxId).all<{ id: string }>(),
    env.DB.prepare('SELECT display_name AS name FROM email_mailboxes WHERE channel_id = ?').bind(mail.mailboxId).first<{ name: string | null }>(),
  ])
  const sender = mail.fromName?.trim() || mail.fromAddress
  return outboxStatement(env, {
    eventId: `mail:${mail.messageId}`,
    kind: 'mail',
    channelId: mail.threadId,
    recipientIds: (readers.results ?? []).map(row => row.id),
    payload: {
      title: mailbox?.name ? `${sender} · ${mailbox.name}` : sender,
      body: notificationPreview([mail.subject, mail.content].filter(Boolean).join(' — '), 0),
      tag: `mail:${mail.threadId}`,
      url: mailPath(mail.mailboxId, 'inbox', mail.threadId),
      icon: '/android-chrome-192x192.png',
      badge: '/favicon-32x32.png',
    },
  })
}

export async function signalNotificationOutbox(env: L4Env): Promise<void> {
  try {
    const stub = asRpc<{ kick: () => Promise<void> }>(env.NOTIFICATION_DO.getByName('notifications:main'))
    await stub.kick()
  }
  catch { /* message delivery must not fail when the optional push path is unavailable */ }
}
