import { Permission } from '../../shared/permissions'
import { channelPath } from '../../shared/paths'
import type { TaskSourceDTO, TaskSourceLinkDTO, TaskMessageDraftDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireChannelAccessForMember, type ServerChannelAccess, type ServerMembership } from './channel-access'
import { readableMentions } from './member-names'
import { taskPermissionAllowed } from './task-policy'

type MessageRow = { id: string; channelId: string; content: string; deletedAt: string | null; authorName: string | null }

function messageRow(env: L4Env, messageId: string) {
  return env.DB.prepare(`SELECT m.id, m.channel_id AS channelId, m.content, m.deleted_at AS deletedAt, COALESCE(u.nickname, u.display_name) AS authorName
    FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = ?`).bind(messageId).first<MessageRow>()
}

/** Where a conversation opens in the Client, and how people recognize it. */
function conversation(access: ServerChannelAccess) {
  const { channel } = access
  const thread = channel.type === 'thread' && channel.parentId
  const root = { id: thread ? channel.parentId! : channel.id, type: access.accessRootType, participants: access.participants }
  const others = access.participants.filter(person => person.id !== access.user.id).map(person => person.displayName)
  const name = thread ? `Thread “${channel.name}”`
    : access.accessRootType === 'dm' ? `Direct message${others.length ? ` with ${others.join(', ')}` : ''}`
      : `#${channel.name}`
  return { name, path: thread ? channelPath(root, channel.id) : channelPath(root) }
}

/**
 * A chat message someone may turn into a Task: they must be able to read its
 * conversation now. Email and task discussions have their own places.
 */
export async function requireTaskSourceMessage(env: L4Env, member: ServerMembership, messageId: string) {
  const message = await messageRow(env, messageId)
  if (!message) fail(404, 'not_found', 'Message not found')
  const access = await requireChannelAccessForMember(env, member, message.channelId)
  if (access.mailPermission) fail(400, 'unsupported_source', 'Tasks cannot be created from email yet')
  const rootId = access.channel.type === 'thread' && access.channel.parentId ? access.channel.parentId : access.channel.id
  if (await env.DB.prepare('SELECT 1 AS found FROM tasks WHERE discussion_channel_id = ? LIMIT 1').bind(rootId).first()) {
    fail(400, 'unsupported_source', 'This message is already part of a task discussion')
  }
  if (message.deletedAt) fail(409, 'message_deleted', 'This message was deleted')
  return { message, access }
}

function draftTitle(text: string, author: string | null): string {
  const line = text.split('\n').map(value => value.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '').trim()).find(Boolean)
  const title = line || `Message from ${author ?? 'a member'}`
  return title.length > 160 ? `${title.slice(0, 159).trimEnd()}…` : title
}

/** A prefilled Task form from a message the Member can read. Nothing is saved. */
export async function taskDraftFromMessage(env: L4Env, member: ServerMembership, messageId: string): Promise<TaskMessageDraftDTO> {
  const { message, access } = await requireTaskSourceMessage(env, member, messageId)
  const [content] = await readableMentions(env, [message.content])
  const attachments = await env.DB.prepare('SELECT filename FROM attachments WHERE message_id = ? ORDER BY created_at LIMIT 20')
    .bind(message.id).all<{ filename: string }>()
  const files = (attachments.results ?? []).map(row => row.filename)
  const place = conversation(access)
  const description = [content!.trim(), files.length ? `Attachments in the source message: ${files.join(', ')}` : '']
    .filter(Boolean).join('\n\n').slice(0, 12_000)
  return { messageId: message.id, channelName: place.name, authorName: message.authorName, title: draftTitle(content!, message.authorName), description }
}

/**
 * The source as this viewer may see it. Someone who cannot read the conversation
 * learns only that the Task came from one, never which or what it said.
 */
export async function taskSourceFor(env: L4Env, member: ServerMembership, taskId: string): Promise<TaskSourceDTO | null> {
  const row = await env.DB.prepare('SELECT source_channel_id AS channelId, source_message_id AS messageId FROM tasks WHERE id = ?')
    .bind(taskId).first<{ channelId: string | null; messageId: string | null }>()
  if (!row?.channelId || !row.messageId) return null
  let access: ServerChannelAccess
  try { access = await requireChannelAccessForMember(env, member, row.channelId) }
  catch { return { state: 'restricted' } }
  const place = conversation(access)
  const message = await messageRow(env, row.messageId)
  if (!message || message.channelId !== row.channelId || message.deletedAt) return { state: 'deleted', channelName: place.name, path: place.path }
  const [content] = await readableMentions(env, [message.content])
  const excerpt = content!.replace(/\s+/gu, ' ').trim()
  return { state: 'available', channelName: place.name, path: `${place.path}?message=${message.id}`, authorName: message.authorName,
    excerpt: excerpt.length > 200 ? `${excerpt.slice(0, 199)}…` : excerpt }
}

/** Tasks created from messages in one conversation, limited to those the viewer can read. */
export async function taskLinksForChannel(env: L4Env, member: ServerMembership, channelId: string): Promise<TaskSourceLinkDTO[]> {
  await requireChannelAccessForMember(env, member, channelId)
  const rows = await env.DB.prepare(`SELECT t.id AS taskId, n.number, t.title, t.board_id AS boardId, t.project_id AS projectId, t.source_message_id AS messageId
    FROM tasks t JOIN task_numbers n ON n.task_id = t.id
    WHERE t.source_channel_id = ? AND t.source_message_id IS NOT NULL AND t.archived_at IS NULL ORDER BY n.number LIMIT 500`)
    .bind(channelId).all<TaskSourceLinkDTO & { boardId: string; projectId: string | null }>()
  return (rows.results ?? []).filter(row => taskPermissionAllowed(member.authorization, row, Permission.readTasks))
    .map(({ taskId, number, title, messageId }) => ({ taskId, number, title, messageId }))
}
