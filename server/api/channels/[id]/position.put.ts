import { z } from 'zod'
import { nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireChannelMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'
import { isChatChannel, signalChannelsChanged } from '../../../utils/channel-lifecycle'

const bodySchema = z.object({
  categoryId: z.string().min(8).nullable(),
  /** The channel this one is placed above; null places it last in the category. */
  beforeId: z.string().min(8).nullable(),
})

/**
 * Moves a channel within or between categories. Positions are renumbered over every root
 * channel, including private ones the mover cannot see, so the stored order stays stable.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  if (!await isChatChannel(env, member.channel)) fail(400, 'invalid_channel', 'Only server channels can be reordered')
  if (body.beforeId === id) fail(400, 'bad_request', 'Choose another channel to place this one before')
  if (body.categoryId && !await env.DB.prepare('SELECT 1 AS found FROM channel_categories WHERE id = ?').bind(body.categoryId).first()) {
    fail(400, 'bad_request', 'Channel category not found')
  }
  const rows = await env.DB.prepare("SELECT id, category_id AS categoryId, position FROM channels WHERE type = 'text' ORDER BY position, created_at, id")
    .all<{ id: string, categoryId: string | null, position: number }>()
  const ordered = (rows.results ?? []).filter(row => row.id !== id)
  let index: number
  if (body.beforeId) {
    index = ordered.findIndex(row => row.id === body.beforeId)
    if (index < 0 || ordered[index]!.categoryId !== body.categoryId) fail(400, 'bad_request', 'Place the channel before a channel in the same category')
  }
  else {
    const last = ordered.findLastIndex(row => row.categoryId === body.categoryId)
    index = last < 0 ? ordered.length : last + 1
  }
  const moved = { id, categoryId: body.categoryId, position: Number.NaN }
  ordered.splice(index, 0, moved)
  const updatedAt = nowIso()
  const statements = ordered.flatMap((row, position) => {
    if (row === moved) {
      return [env.DB.prepare('UPDATE channels SET position = ?, category_id = ?, updated_at = ? WHERE id = ?').bind(position + 1, body.categoryId, updatedAt, id)]
    }
    return row.position === position + 1 ? [] : [env.DB.prepare('UPDATE channels SET position = ? WHERE id = ?').bind(position + 1, row.id)]
  })
  await env.DB.batch(statements)
  await writeAudit(env, {
    serverId: member.serverId,
    actorId: member.user.id,
    action: 'channel.move',
    targetType: 'channel',
    targetId: id,
    meta: { categoryId: body.categoryId, beforeId: body.beforeId },
  })
  waitUntil(signalChannelsChanged(env, member.serverId))
  return { ok: true }
})
