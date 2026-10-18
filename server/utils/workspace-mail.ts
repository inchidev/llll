import { getServerId } from '../../shared/server-id'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { users } from '../../drizzle/schema'
import { newId, nowIso } from '../../shared/ids'
import { cloudflareNetwork, type L4Env } from '../../workers/env'
import type { MailboxPermission } from '../../shared/types'
import { MAIL_DOMAIN_ID, MAIL_EXTERNAL_USER_ID, mailAddress, mailPermissionAllows, normalizeMailLocalPart } from '../../shared/mail'
import { requireChannelAccess } from './guards'
import { fail } from './cf'
import { getDb } from './db'

export type WorkspaceMailDomainConfig = {
  id: string
  zoneId: string
  domain: string
}

function validDomainConfig(value: unknown): value is WorkspaceMailDomainConfig {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkspaceMailDomainConfig>
  return typeof item.id === 'string' && Boolean(item.id.trim())
    && typeof item.zoneId === 'string' && Boolean(item.zoneId.trim())
    && typeof item.domain === 'string' && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(item.domain.trim().toLowerCase())
}

export function workspaceMailDomains(env: L4Env): WorkspaceMailDomainConfig[] {
  const configured: WorkspaceMailDomainConfig[] = []
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
      // Invalid deployment metadata is ignored; legacy bindings remain available below.
    }
  }
  const legacyDomain = env.MAIL_DOMAIN?.trim().toLowerCase()
  const legacyZoneId = env.MAIL_ZONE_ID?.trim()
  if (legacyDomain && !configured.some(item => item.domain === legacyDomain)) {
    // Cloudflare routing still needs a zone. Off that network the domain alone
    // is enough; zone_id is NOT NULL, so an empty string stands in for "none".
    if (legacyZoneId) configured.unshift({ id: MAIL_DOMAIN_ID, zoneId: legacyZoneId, domain: legacyDomain })
    else if (!cloudflareNetwork(env)) configured.unshift({ id: MAIL_DOMAIN_ID, zoneId: '', domain: legacyDomain })
  }
  return [...new Map(configured.map(item => [item.domain, item])).values()]
}

export async function ensureWorkspaceMailFromEnv(env: L4Env): Promise<void> {
  const appHostname = env.MAIL_APP_HOSTNAME?.trim().toLowerCase()
  const domains = workspaceMailDomains(env)
  if (!appHostname) return

  const configuredIds = domains.map(domain => domain.id)
  if (!configuredIds.length) {
    await env.DB.prepare('DELETE FROM email_domains WHERE id NOT IN (SELECT DISTINCT domain_id FROM email_mailboxes)').run()
    return
  }

  const owner = await env.DB.prepare('SELECT owner_id as ownerId FROM workspace WHERE id = ?').bind(await getServerId(env.DB)).first<{ ownerId: string }>()
  if (!owner) return
  const created = nowIso()
  const existing = await env.DB.prepare('SELECT channel_id as channelId, local_part as localPart FROM email_mailboxes LIMIT 1').first<{ channelId: string; localPart: string }>()
  const createDefaultMailbox = !existing && Boolean(env.MAIL_DEFAULT_LOCAL_PART?.trim())
  const localPart = existing?.localPart || normalizeMailLocalPart(env.MAIL_DEFAULT_LOCAL_PART || 'inbox')
  const channelId = existing?.channelId || newId()
  const defaultDomain = domains[0]!
  const identityCreated = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO identity_keys (id, name, email, email_verified, image, created_at, updated_at)
       VALUES (?, 'Email', 'mail@identity.llll.invalid', 0, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(MAIL_EXTERNAL_USER_ID, identityCreated, identityCreated),
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
      `INSERT INTO email_mailbox_access (channel_id, user_id, permission, created_at, updated_at)
       VALUES (?, ?, 'manage', ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE SET permission = 'manage', updated_at = excluded.updated_at`,
    ).bind(channelId, owner.ownerId, created, created)] : []),
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
  const access = await requireChannelAccess(event, channelId)
  if (!access.mailPermission) fail(404, 'not_found', 'Mailbox not found')
  if (!mailPermissionAllows(access.mailPermission, needed)) fail(403, 'forbidden', 'Missing mailbox permission')
  const mailboxId = access.channel.type === 'thread' && access.channel.parentId ? access.channel.parentId : access.channel.id
  return { ...access, mailboxId, mailPermission: access.mailPermission }
}

export async function replaceMailboxAccess(env: L4Env, channelId: string, rows: Array<{ userId: string; permission: MailboxPermission }>) {
  const db = getDb(env.DB)
  const active = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'))
  const validIds = new Set(active.map(row => row.id))
  const unique = new Map(rows.filter(row => validIds.has(row.userId)).map(row => [row.userId, row.permission]))
  const created = nowIso()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_mailbox_access WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM channel_members WHERE channel_id = ?').bind(channelId),
    ...[...unique].flatMap(([userId, permission]) => [
      env.DB.prepare('INSERT INTO channel_members (channel_id, user_id, hidden_at, joined_at) VALUES (?, ?, NULL, ?)').bind(channelId, userId, created),
      env.DB.prepare('INSERT INTO email_mailbox_access (channel_id, user_id, permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(channelId, userId, permission, created, created),
    ]),
  ])
}
