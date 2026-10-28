import { retryMailFileCleanup } from '../../utils/mail-cleanup'
import { getServerId } from '../../../shared/server-id'
import type { MailboxDTO } from '../../../shared/types'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { listGrantedMailboxes } from '../../utils/mail-data'
import { hasPermission, Permission } from '../../../shared/permissions'
import { mailFilesAvailable } from '../../../shared/mail-attachments'

export default defineEventHandler(async (event): Promise<{ mailboxes: MailboxDTO[] }> => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  if (!member.isOwner && !hasPermission(member.perms, Permission.readMail)) return { mailboxes: [] }
  const { env, waitUntil } = cf(event)
  waitUntil(retryMailFileCleanup(env))
  const attachments = mailFilesAvailable(env)
  return { mailboxes: (await listGrantedMailboxes(env, member.user.id)).map(mailbox => ({ ...mailbox, attachments })) }
})
