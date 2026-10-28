import { z } from 'zod'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { deleteMailDraftStatements, findMailDraft } from '../../../../utils/mail-drafts'
import { retryMailFileCleanup } from '../../../../utils/mail-cleanup'

const schema = z.object({ draftId: z.string().trim().min(1).max(80) })

/** Discards one of your drafts and the files uploaded for it. */
export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const mailboxId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, mailboxId, 'send')
  if (access.channel.type !== 'text') fail(404, 'not_found', 'Mailbox not found')
  const { draftId } = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const draft = await findMailDraft(env, mailboxId, access.user.id, draftId)
  if (!draft) fail(404, 'not_found', 'Draft not found')
  await env.DB.batch(deleteMailDraftStatements(env, draft, access.user.id))
  waitUntil(retryMailFileCleanup(env))
  return { ok: true }
})
