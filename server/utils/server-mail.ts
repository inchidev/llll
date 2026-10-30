import { getServerId } from '../../shared/server-id'
import { MAIL_DEFAULT_LOCAL_PART, readServerSetting, writeServerSetting } from '../../shared/server-settings'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { users } from '../../drizzle/schema'
import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission } from '../../shared/permissions'
import { asRpc } from '../../workers/env'
import type { L4Env } from '../../workers/env'
import type { MailboxPermission } from '../../shared/types'
import { MAIL_EXTERNAL_USER_ID, mailAddress, mailboxGrantPermissions, mailPermissionAllows, normalizeMailLocalPart } from '../../shared/mail'
import { requireChannelAccess } from './guards'
import type { ServerChannelAccess } from './channel-access'
import { fail } from './cf'
import { getDb } from './db'

export type ServerMailDomainConfig = {
  id: string
  zoneId: string
  domain: string
}

function validDomainConfig(value: unknown): value is ServerMailDomainConfig {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ServerMailDomainConfig>
  return typeof item.id === 'string' && Boolean(item.id.trim())
    && typeof item.zoneId === 'string'
    && typeof item.domain === 'string' && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(item.domain.trim().toLowerCase())
}

/** Legacy env shape, kept for migration and unit tests. */
export function serverMailDomains(env: L4Env): ServerMailDomainConfig[] {
  const configured: ServerMailDomainConfig[] = []
  if (env.LLLL_EMAIL_DOMAINS) {
    try {
      const value = JSON.parse(env.LLLL_EMAIL_DOMAINS) as unknown
      if (Array.isArray(value)) configured.push(...value.filter(validDomainConfig).map(item => ({
        id: item.id.trim(),
        zoneId: item.zoneId.trim(),
        domain: item.domain.trim().toLowerCase(),
      })))
    }
    catch {
      // Invalid domain metadata does not enable inbound email.
    }
  }
  return [...new Map(configured.map(item => [item.domain, item])).values()]
}

type StoredMailDomain = { id: string; zoneId: string; domain: string; appHostname: string }

function parseMailDomains(value: string | null | undefined): ServerMailDomainConfig[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validDomainConfig).map(item => ({
      id: item.id.trim(),
      zoneId: item.zoneId.trim(),
      domain: item.domain.trim().toLowerCase(),
    }))
  }
  catch {
    return []
  }
}

async function storedMailDomains(env: L4Env): Promise<StoredMailDomain[]> {
  if (!env.DB) return []
  try {
    const rows = await env.DB.prepare(
      'SELECT id, zone_id as zoneId, domain, app_hostname as appHostname FROM email_domains ORDER BY created_at, id',
    ).all<StoredMailDomain>()
    return rows.results || []
  }
  catch {
    // A database without the mail tables keeps the legacy env configuration.
    return []
  }
}

/** D1 is authoritative once onboarding has run; env is only the one-time legacy source. */
export async function readServerMailDomains(env: L4Env): Promise<ServerMailDomainConfig[]> {
  const rows = await storedMailDomains(env)
  if (rows.length) return rows.map(row => ({ id: row.id, zoneId: row.zoneId, domain: row.domain }))
  let configured: ServerMailDomainConfig[] = []
  try { configured = parseMailDomains(await readServerSetting(env.DB, 'mail_domains')) } catch { /* No settings table yet. */ }
  return configured.length ? configured : serverMailDomains(env)
}

export async function ensureServerMailFromEnv(env: L4Env): Promise<void> {
  const [storedAppHostname, storedLocalPart, storedDomains, existingDomains] = await Promise.all([
    readServerSetting(env.DB, 'mail_app_hostname'),
    readServerSetting(env.DB, MAIL_DEFAULT_LOCAL_PART),
    readServerSetting(env.DB, 'mail_domains'),
    storedMailDomains(env),
  ])
  const appHostname = (storedAppHostname || env.MAIL_APP_HOSTNAME || existingDomains[0]?.appHostname || '').trim().toLowerCase()
  const domains = parseMailDomains(storedDomains).length ? parseMailDomains(storedDomains) : serverMailDomains(env).length ? serverMailDomains(env) : existingDomains.map(row => ({ id: row.id, zoneId: row.zoneId, domain: row.domain }))
  const localPartSetting = (storedLocalPart || env.MAIL_DEFAULT_LOCAL_PART || '').trim()
  if (!appHostname) return

  if (!storedAppHostname) await writeServerSetting(env.DB, 'mail_app_hostname', appHostname)
  if (!storedLocalPart && localPartSetting) await writeServerSetting(env.DB, MAIL_DEFAULT_LOCAL_PART, localPartSetting)
  if (!storedDomains && domains.length) await writeServerSetting(env.DB, 'mail_domains', JSON.stringify(domains))

  const configuredIds = domains.map(domain => domain.id)
  if (!configuredIds.length) {
    await env.DB.prepare('DELETE FROM email_domains WHERE id NOT IN (SELECT DISTINCT domain_id FROM email_mailboxes)').run()
    return
  }

  const owner = await env.DB.prepare('SELECT owner_id as ownerId FROM server WHERE id = ?').bind(await getServerId(env.DB)).first<{ ownerId: string }>()
  if (!owner) return
  const created = nowIso()
  const existing = await env.DB.prepare('SELECT channel_id as channelId, local_part as localPart FROM email_mailboxes LIMIT 1').first<{ channelId: string; localPart: string }>()
  const createDefaultMailbox = !existing && Boolean(localPartSetting)
  const localPart = existing?.localPart || normalizeMailLocalPart(localPartSetting || 'inbox')
  const channelId = existing?.channelId || newId()
  const defaultDomain = domains[0]!

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, kind, handle, display_name, avatar_r2_key, status, role_id, nickname, joined_at, created_at, updated_at)
       VALUES (?, 'human', NULL, 'Email', NULL, 'removed', NULL, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(MAIL_EXTERNAL_USER_ID, created, created),
    ...domains.map(domain => env.DB.prepare(
      `INSERT INTO email_domains (id, zone_id, domain, app_hostname, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET zone_id = excluded.zone_id, domain = excluded.domain,
         app_hostname = excluded.app_hostname, updated_at = excluded.updated_at`,
    ).bind(domain.id, domain.zoneId, domain.domain, appHostname, created, created)),
    ...(createDefaultMailbox ? [env.DB.prepare(
      `INSERT INTO channels (id, name, topic, type, visibility, category_id, position, live_meeting_id, parent_id, parent_message_id, created_at, updated_at)
       VALUES (?, ?, '', 'text', 'private', NULL, 0, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).bind(channelId, mailAddress(localPart, defaultDomain.domain), created, created),
    env.DB.prepare(
      `INSERT INTO email_mailboxes (channel_id, domain_id, local_part, display_name, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'Inbox', 1, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET domain_id = excluded.domain_id, updated_at = excluded.updated_at`,
    ).bind(channelId, defaultDomain.id, localPart, created, created),
    env.DB.prepare(
      `INSERT INTO channel_members (channel_id, user_id, hidden_at, joined_at)
       VALUES (?, ?, NULL, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET hidden_at = NULL`,
    ).bind(channelId, owner.ownerId, created),
    env.DB.prepare(
      `INSERT INTO grants (id, member_id, permissions, mailbox_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_id, member_id) WHERE mailbox_id IS NOT NULL DO UPDATE SET permissions = excluded.permissions`,
    ).bind(newId(), owner.ownerId, mailboxGrantPermissions.manage, channelId, created)] : []),
  ])
  const placeholders = configuredIds.map(() => '?').join(', ')
  await env.DB.prepare(
    `DELETE FROM email_domains WHERE id NOT IN (${placeholders}) AND id NOT IN (SELECT DISTINCT domain_id FROM email_mailboxes)`,
  ).bind(...configuredIds).run()
}

/**
 * Mailbox access for a mailbox channel or one of its conversations. The channel
 * guard already loads the mailbox and the member's grant, so this adds no query.
 */
export async function requireMailboxPermission(event: H3Event, channelId: string, needed: MailboxPermission) {
  return mailboxPermission(await requireChannelAccess(event, channelId), needed)
}

/** The mailbox grant and email policy on a resolved channel access, shared by HTTP and MCP. */
export function mailboxPermission(access: ServerChannelAccess, needed: MailboxPermission) {
  if (!access.mailPermission) fail(404, 'not_found', 'Mailbox not found')
  if (!mailPermissionAllows(access.mailPermission, needed)) fail(403, 'forbidden', 'Missing mailbox permission')
  if (needed !== 'read' && !access.isOwner && !hasPermission(access.perms, Permission.sendMail)) fail(403, 'forbidden', 'Missing email policy')
  const mailboxId = access.channel.type === 'thread' && access.channel.parentId ? access.channel.parentId : access.channel.id
  return { ...access, mailboxId, mailPermission: access.mailPermission }
}

export async function replaceMailboxAccess(env: L4Env, channelId: string, rows: Array<{ userId: string; permission: MailboxPermission }>, actorId: string) {
  const db = getDb(env.DB)
  const active = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'))
  const validIds = new Set(active.map(row => row.id))
  const unique = new Map(rows.filter(row => validIds.has(row.userId)).map(row => [row.userId, row.permission]))
  const created = nowIso()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants WHERE mailbox_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM channel_members WHERE channel_id = ?').bind(channelId),
    ...[...unique].flatMap(([userId, permission]) => [
      env.DB.prepare('INSERT INTO channel_members (channel_id, user_id, hidden_at, joined_at) VALUES (?, ?, NULL, ?)').bind(channelId, userId, created),
      env.DB.prepare('INSERT INTO grants (id, member_id, permissions, mailbox_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), userId, mailboxGrantPermissions[permission], channelId, actorId, created),
    ]),
  ])
}

/** Bound external sends per Member and mailbox, shared by new mail, replies and retries. */
export async function requireMailSendLimit(env: L4Env, mailboxId: string, userId: string): Promise<void> {
  let allowed: boolean
  try {
    const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`mail:${mailboxId}:${userId}`))
    allowed = await limiter.take(10, 60_000)
  }
  catch {
    fail(503, 'mail_rate_limit_unavailable', 'Email sending is temporarily unavailable. Try again shortly.')
  }
  if (!allowed) fail(429, 'rate_limited', 'Too many emails. Try again in a minute.')
}
