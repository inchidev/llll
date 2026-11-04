import { CHANNEL_PERMISSION_MASK } from '../../shared/channel-permissions'
import { mailboxGrantPermissions } from '../../shared/mail'
import type { MailboxPermission } from '../../shared/types'

let next = 0
const id = () => `test-grant-${++next}`

/** SQL that gives Members access to mailboxes: [mailbox channel, user, permission]. */
export function mailboxGrantsSql(...rows: Array<[string, string, MailboxPermission]>): string {
  return `INSERT INTO grants(id,member_id,permissions,mailbox_id,created_at) VALUES ${rows
    .map(([mailbox, user, permission]) => `('${id()}','${user}',${mailboxGrantPermissions[permission]},'${mailbox}','2026-01-01T00:00:00.000Z')`).join(',')};`
}

/** SQL that sets a Role's channel override: allows as a grant, denies in channel_role_denies. */
export function channelOverrideSql(channel: string, role: string, allow: number, deny: number): string {
  if ((allow | deny) & ~CHANNEL_PERMISSION_MASK) throw new Error('Unsupported channel permission')
  return `DELETE FROM grants WHERE channel_id='${channel}' AND role_id='${role}'; DELETE FROM channel_role_denies WHERE channel_id='${channel}' AND role_id='${role}';`
    + (allow ? `INSERT INTO grants(id,role_id,permissions,channel_id,created_at) VALUES ('${id()}','${role}',${allow},'${channel}','2026-01-01T00:00:00.000Z');` : '')
    + (deny ? `INSERT INTO channel_role_denies(channel_id,role_id,deny_mask,created_at) VALUES ('${channel}','${role}',${deny},'2026-01-01T00:00:00.000Z');` : '')
}
