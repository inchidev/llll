import type { L4Env } from '../../workers/env'

/** The outbound email a client request key already created in this mailbox, if any. */
export async function findOutboundRequest(env: L4Env, mailboxId: string, clientId: string) {
  return env.DB.prepare(
    `SELECT message_id as messageId, thread_channel_id as threadChannelId FROM email_messages
     WHERE mailbox_channel_id = ? AND client_request_id = ?`,
  ).bind(mailboxId, clientId).first<{ messageId: string; threadChannelId: string }>()
}

export function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/iu.test(error instanceof Error ? error.message : String(error))
}
