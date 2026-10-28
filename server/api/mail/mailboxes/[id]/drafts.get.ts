import type { MailDraftDTO } from '../../../../../shared/types'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { listMailDrafts } from '../../../../utils/mail-drafts'

/** Your own drafts in this mailbox, newest first. Losing Send on the mailbox hides them. */
export default defineEventHandler(async (event): Promise<{ drafts: MailDraftDTO[] }> => {
  const mailboxId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, mailboxId, 'send')
  if (access.channel.type !== 'text') fail(404, 'not_found', 'Mailbox not found')
  return { drafts: await listMailDrafts(cf(event).env, mailboxId, access.user.id) }
})
