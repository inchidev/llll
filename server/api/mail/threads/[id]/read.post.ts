import { z } from 'zod'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { markMailThreadRead } from '../../../../utils/mail-data'
import { parseBody } from '../../../../utils/validate'

const schema = z.object({ messageId: z.string().min(8).max(80) })

/** Marks a conversation read up to a message. Reading only ever moves forward. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'read')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const body = parseBody(schema, await readBody(event))
  await markMailThreadRead(cf(event).env, id, access.user.id, body.messageId)
  return { ok: true }
})
