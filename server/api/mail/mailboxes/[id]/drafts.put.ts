import type { MailDraftDTO } from '../../../../../shared/types'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { mailDraftSchema, saveMailDraft } from '../../../../utils/mail-drafts'

/** Saves a draft: a new one without `id`, or the reply draft for `threadId`, or the draft `id`. */
export default defineEventHandler(async (event): Promise<{ draft: MailDraftDTO }> => {
  const mailboxId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, mailboxId, 'send')
  if (access.channel.type !== 'text') fail(404, 'not_found', 'Mailbox not found')
  const body = parseBody(mailDraftSchema, await readBody(event))
  return { draft: await saveMailDraft(cf(event).env, mailboxId, access.user.id, body) }
})
