import { inArray } from 'drizzle-orm'
import { attachments, channels, messageMentions, messagePins, messageReactions, messages, users } from '../../drizzle/schema'
import type { AttachmentDTO, MessageDTO, MessagePinDTO, PublicUser, ReactionDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { WORKSPACE_ID } from '../../shared/ids'
import { getDb } from './db'

export function toPublicUser(row: typeof users.$inferSelect): PublicUser {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    avatarR2Key: row.avatarR2Key,
  }
}

export function attachmentDto(row: typeof attachments.$inferSelect): AttachmentDTO {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    url: `/api/files/${row.id}`,
  }
}

export async function hydrateMessages(env: L4Env, rows: Array<typeof messages.$inferSelect>, viewerId?: string): Promise<MessageDTO[]> {
  if (!rows.length) return []
  const db = getDb(env.DB)
  const ids = rows.map((r) => r.id)
  const authorIds = [...new Set(rows.map((r) => r.authorId))]
  const replyIds = rows.map((r) => r.replyToId).filter((x): x is string => Boolean(x))

  // Every lookup depends only on the page's ids, so they share one round trip.
  const [pinRows, authorRows, mentionRows, attRows, replyRows, reactionRows, threadRows] = await Promise.all([
    db.select().from(messagePins).where(inArray(messagePins.messageId, ids)),
    db.select().from(users).where(inArray(users.id, authorIds)),
    db.select().from(messageMentions).where(inArray(messageMentions.messageId, ids)),
    db.select().from(attachments).where(inArray(attachments.messageId, [...new Set([...ids, ...replyIds])])),
    replyIds.length ? db.select().from(messages).where(inArray(messages.id, replyIds)) : Promise.resolve([]),
    db.select().from(messageReactions).where(inArray(messageReactions.messageId, ids)),
    db.select({ id: channels.id, parentMessageId: channels.parentMessageId }).from(channels).where(inArray(channels.parentMessageId, ids)),
  ])
  const authors = new Map(authorRows.map((u) => [u.id, toPublicUser(u)]))
  // Whoever pinned a message is usually one of its authors; look up the rest.
  const missingPinners = [...new Set(pinRows.map(pin => pin.pinnedBy))].filter(id => !authors.has(id))
  if (missingPinners.length) {
    for (const u of await db.select().from(users).where(inArray(users.id, missingPinners))) authors.set(u.id, toPublicUser(u))
  }
  const pins = new Map<string, MessagePinDTO>()
  for (const pin of pinRows) {
    const pinnedBy = authors.get(pin.pinnedBy)
    if (pinnedBy) pins.set(pin.messageId, { pinnedBy, pinnedAt: pin.pinnedAt })
  }

  const mentions = new Map<string, string[]>()
  for (const m of mentionRows) {
    const list = mentions.get(m.messageId) ?? []
    list.push(m.userId)
    mentions.set(m.messageId, list)
  }

  const atts = new Map<string, AttachmentDTO[]>()
  for (const a of attRows) {
    if (!a.messageId) continue
    const list = atts.get(a.messageId) ?? []
    list.push(attachmentDto(a))
    atts.set(a.messageId, list)
  }

  const replies = new Map<string, NonNullable<MessageDTO['replyTo']>>()
  for (const r of replyRows) {
    replies.set(r.id, {
      id: r.id,
      authorId: r.authorId,
      content: (r.deletedAt ? '' : r.content).slice(0, 180),
      attachmentCount: atts.get(r.id)?.length ?? 0,
      deleted: Boolean(r.deletedAt),
    })
  }

  const reactionMap = new Map<string, ReactionDTO[]>()
  for (const r of reactionRows) {
    const list = reactionMap.get(r.messageId) ?? []
    const existing = list.find((x) => x.emoji === r.emoji)
    if (existing) {
      existing.count += 1
      if (viewerId && r.userId === viewerId) existing.me = true
    }
    else {
      list.push({ emoji: r.emoji, count: 1, me: Boolean(viewerId && r.userId === viewerId) })
    }
    reactionMap.set(r.messageId, list)
  }

  const threads = new Map<string, string>()
  for (const t of threadRows) {
    if (t.parentMessageId) threads.set(t.parentMessageId, t.id)
  }

  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    workspaceId: WORKSPACE_ID,
    author: authors.get(row.authorId) ?? { id: row.authorId, kind: 'human', displayName: 'Unknown', avatarR2Key: null },
    content: row.deletedAt ? '' : row.content,
    replyTo: row.replyToId ? replies.get(row.replyToId) ?? null : null,
    mentions: mentions.get(row.id) ?? [],
    attachments: atts.get(row.id) ?? [],
    reactions: reactionMap.get(row.id) ?? [],
    pin: pins.get(row.id) ?? null,
    threadId: threads.get(row.id) ?? null,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  }))
}

export async function writeAudit(
  env: L4Env,
  input: { workspaceId: string; actorId: string; action: string; targetType: string; targetId: string; meta?: Record<string, unknown>; authorization?: import('../../shared/authorization').AuthorizationContext },
) {
  const { newId, nowIso } = await import('../../shared/ids')
  const { auditAttribution } = await import('../../shared/authorization')
  await env.DB.prepare(
    'INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    newId(),
    input.actorId,
    input.action,
    input.targetType,
    input.targetId,
    JSON.stringify({ ...(input.meta ?? {}), ...(input.authorization ? auditAttribution(input.authorization) : {}) }),
    nowIso(),
  ).run()
}
