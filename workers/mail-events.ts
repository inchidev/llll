import { getServerId } from '../shared/server-id'
import type { ServerMailChangedEvent } from '../shared/server-realtime'
import type { L4Env } from './env'
import { asRpc } from './env'

/** Tells everyone with access to a mailbox that it changed, so open mail views refresh. */
export async function signalMailChanged(env: L4Env, mailboxId: string, threadId: string | null = null): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT a.user_id as userId FROM email_mailbox_access a
     JOIN users u ON u.id = a.user_id
     WHERE a.channel_id = ? AND u.status = 'active'`,
  ).bind(mailboxId).all<{ userId: string }>()
  const recipientIds = (rows.results ?? []).map(row => row.userId)
  if (!recipientIds.length) return
  const event: ServerMailChangedEvent = { t: 'mail.changed', mailboxId, threadId }
  const stub = asRpc<{
    notifyMailChanged: (event: ServerMailChangedEvent, recipientIds: string[]) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${(await getServerId(env.DB))}`))
  await stub.notifyMailChanged(event, recipientIds)
}
