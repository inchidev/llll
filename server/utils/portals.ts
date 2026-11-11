import { eq } from 'drizzle-orm'
import { users } from '../../drizzle/schema'
import { Permission } from '../../shared/permissions'
import { PORTAL_LIFETIME_MS, portalLinks, type OpenedPortal, type PortalRecord } from '../../shared/portal'
import { getServerId } from '../../shared/server-id'
import { sha256Hex } from '../../shared/server-settings'
import { newId } from '../../shared/ids'
import { asRpc, type L4Env } from '../../workers/env'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import { fail } from './cf'
import { getDb } from './db'
import { toPublicUser } from './messages'

type PortalRoom = {
  open: (record: PortalRecord) => Promise<void>
  record: () => Promise<PortalRecord | null>
  end: () => Promise<void>
}

/** The Durable Object of one Portal. Servers installed before Portal have no binding for it. */
export function portalRoom(env: L4Env, portalId: string) {
  if (!env.PORTAL_DO) fail(501, 'portal_unavailable', 'This Server was installed before Portal. Update it to use Portal.')
  return asRpc<PortalRoom>(env.PORTAL_DO.getByName(`portal:${portalId}`))
}

/** A key given out once: 32 random bytes, base64url. */
export function portalKey(): string {
  let binary = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Open a Portal in a conversation for a Member already checked to start one there. */
export async function openPortal(env: L4Env, opts: { channelId: string, userId: string, origin: string, now?: number }): Promise<OpenedPortal> {
  const now = opts.now ?? Date.now()
  const keys = { host: portalKey(), guest: portalKey() }
  const record: PortalRecord = {
    id: newId(),
    channelId: opts.channelId,
    createdBy: opts.userId,
    createdAt: now,
    expiresAt: now + PORTAL_LIFETIME_MS,
    hostKeyHash: await sha256Hex(keys.host),
    guestKeyHash: await sha256Hex(keys.guest),
    endedAt: null,
  }
  await portalRoom(env, record.id).open(record)
  return { portalId: record.id, ...portalLinks(opts.origin, record.id, keys), expiresAt: new Date(record.expiresAt).toISOString() }
}

/**
 * Whether the Member who opened a Portal may still keep it: active, and still allowed to start Live in its
 * conversation. Only a definite refusal answers no; a check that could not run says nothing and keeps the Portal.
 */
export async function portalOpenerMayKeep(env: L4Env, record: Pick<PortalRecord, 'channelId' | 'createdBy'>): Promise<boolean> {
  try {
    const row = (await getDb(env.DB).select().from(users).where(eq(users.id, record.createdBy)).limit(1))[0]
    if (!row || row.status !== 'active') return false
    const member = requireMemberForUser(env, toPublicUser(row), await getServerId(env.DB), Permission.startLive)
    await requireChannelAccessForMember(env, member, record.channelId, Permission.startLive, 'POST')
    return true
  }
  catch (error) {
    const status = (error as { statusCode?: number })?.statusCode
    return !(status === 401 || status === 403 || status === 404 || status === 409)
  }
}
