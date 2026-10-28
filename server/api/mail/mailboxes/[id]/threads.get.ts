import type { MailThreadPageDTO } from '../../../../../shared/types'
import { isMailFolder } from '../../../../../shared/paths'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf } from '../../../../utils/cf'
import { listMailThreads } from '../../../../utils/mail-threads'

export default defineEventHandler(async (event): Promise<MailThreadPageDTO> => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, channelId, 'read')
  const query = getQuery(event)
  // `status` is the folder: a thread status, or Sent.
  const folder = isMailFolder(query.status) ? query.status : 'inbox'
  // `q` searches this folder of this mailbox only; access was checked above.
  return listMailThreads(cf(event).env, { mailboxId: access.mailboxId, userId: access.user.id, folder, before: query.before, search: typeof query.q === 'string' ? query.q : null })
})
