import { getServerId } from '../../shared/server-id'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { authUsers, roles, users, server } from '../../drizzle/schema'
import type { PublicUser, SessionUser } from '../../shared/types'
import { nowIso } from '../../shared/ids'
import { sessionAuthFromEvent } from './better-auth'
import { loadAuthRuntimeConfig } from './auth-config'
import { authMode, cloudflareAccessIdentity, type CloudflareAccessIdentity } from './cloudflare-access'
import { accountEmail, generatedUsername } from './account-identity'
import { provisionServer } from './bootstrap'
import { cf, fail } from './cf'
import { getDb } from './db'
import { writeAudit } from './messages'
import { signalMembersChanged } from '../../workers/member-events'
import { recordingKeyRequest } from './recording-keys'
import {
  consumeSocialOnboardingTicket,
  hasAcceptedCurrentOnboarding,
  loadCurrentOnboarding,
  recordOnboardingAcceptance,
} from './onboarding'

type AuthIdentity = { id: string; email: string; username?: string | null; displayUsername?: string | null; name: string; image?: string | null }

/** A Member's mention handle starts as their username, when no other Member holds it. */
async function freeHandle(db: ReturnType<typeof getDb>, username: string | null | undefined): Promise<string | null> {
  if (!username) return null
  return (await db.select({ id: users.id }).from(users).where(eq(users.handle, username)).limit(1))[0] ? null : username
}

export async function ensureDomainUser(event: H3Event, identity: AuthIdentity) {
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  let row = (await db.select().from(users).where(eq(users.id, identity.id)).limit(1))[0]
  if (row) return row

  const [runtime, onboarding] = await Promise.all([
    loadAuthRuntimeConfig(env, getRequestURL(event).origin),
    loadCurrentOnboarding(env),
  ])
  const socialRevisionId = await consumeSocialOnboardingTicket(event)
  if (socialRevisionId && socialRevisionId === onboarding.revisionId) {
    await recordOnboardingAcceptance(env, identity.id, socialRevisionId)
  }
  const accepted = await hasAcceptedCurrentOnboarding(env, identity.id, onboarding)
  const memberRole = (runtime.mode === 'access' || runtime.registrationMode === 'open') && accepted
    ? (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
    : null
  const created = nowIso()
  const active = Boolean(memberRole)
  const displayName = identity.name || identity.username || accountEmail(identity)?.split('@')[0] || 'member'
  const member = {
    id: identity.id,
    displayName,
    avatarR2Key: identity.image ?? null,
    status: active ? 'active' as const : 'pending' as const,
    roleId: memberRole?.id ?? null,
    nickname: null,
    joinedAt: active ? created : null,
    createdAt: created,
    updatedAt: created,
  }
  await db.insert(users).values({ ...member, handle: await freeHandle(db, identity.username) }).onConflictDoNothing()
  row = (await db.select().from(users).where(eq(users.id, identity.id)).limit(1))[0]
  if (!row) {
    // Someone took the handle between the check and the insert. The handle is only a default.
    await db.insert(users).values({ ...member, handle: null }).onConflictDoNothing()
    row = (await db.select().from(users).where(eq(users.id, identity.id)).limit(1))[0]!
  }
  if (active) {
    await writeAudit(env, {
      serverId: await getServerId(env.DB),
      actorId: identity.id,
      action: 'member.join',
      targetType: 'user',
      targetId: identity.id,
      meta: { admission: runtime.mode === 'access' ? 'access' : 'open' },
    })
    waitUntil(signalMembersChanged(env, await getServerId(env.DB)))
  }
  return row
}

export function publicUser(row: { id: string; kind: 'human' | 'agent'; displayName: string; avatarR2Key: string | null }): PublicUser {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    avatarR2Key: row.avatarR2Key,
  }
}

export async function sessionUser(
  event: H3Event,
  row: typeof users.$inferSelect,
  account: { username?: string | null; displayUsername?: string | null; email: string | null },
): Promise<SessionUser> {
  const { env } = cf(event)
  return {
    ...publicUser(row),
    username: account.username ?? null,
    displayUsername: account.displayUsername ?? account.username ?? null,
    email: account.email,
    status: row.status,
    onboardingRequired: row.status === 'pending' && !(await hasAcceptedCurrentOnboarding(env, row.id)),
  }
}

export async function activateOpenMember(event: H3Event, userId: string) {
  const { env, waitUntil } = cf(event)
  const runtime = await loadAuthRuntimeConfig(env, getRequestURL(event).origin)
  if (runtime.mode !== 'access' && runtime.registrationMode !== 'open') return
  if (!(await hasAcceptedCurrentOnboarding(env, userId))) return
  const db = getDb(env.DB)
  const row = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!row || row.status !== 'pending') return
  const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
  if (!memberRole) fail(500, 'internal', 'Member role missing')
  const joinedAt = nowIso()
  await db.update(users).set({
    status: 'active',
    roleId: memberRole.id,
    joinedAt,
    updatedAt: joinedAt,
  }).where(eq(users.id, userId))
  await writeAudit(env, {
    serverId: await getServerId(env.DB),
    actorId: userId,
    action: 'member.join',
    targetType: 'user',
    targetId: userId,
    meta: { admission: runtime.mode === 'access' ? 'access' : 'open', onboarding: true },
  })
  waitUntil(signalMembersChanged(env, await getServerId(env.DB)))
}

const CURRENT_USER = Symbol('llll.currentUser')

/** Resolves the signed-in user once per request; guards call this repeatedly. */
export function currentUser(event: H3Event): Promise<SessionUser | null> {
  const context = event.context as { [CURRENT_USER]?: Promise<SessionUser | null> }
  context[CURRENT_USER] ??= resolveCurrentUser(event)
  return context[CURRENT_USER]
}

async function resolveCurrentUser(event: H3Event): Promise<SessionUser | null> {
  const { env } = cf(event)
  const db = getDb(env.DB)
  // A device key signs in on its one route and nowhere else, whatever cookies come with it.
  const keyed = await recordingKeyRequest(event)
  if (keyed !== undefined) {
    const row = keyed && (await db.select().from(users).where(eq(users.id, keyed.userId)).limit(1))[0]
    return row ? sessionUser(event, row, { email: null }) : null
  }
  if (authMode(env) === 'access') {
    const accessIdentity = await cloudflareAccessIdentity(event)
    if (!accessIdentity) return null
    const identity = await ensureAccessIdentity(event, accessIdentity)
    const row = (await db.select().from(users).where(eq(users.id, identity.id)).limit(1))[0]
      || await ensureDomainUser(event, identity)
    return sessionUser(event, row, { username: identity.username, displayUsername: identity.displayUsername, email: identity.email })
  }
  const auth = await sessionAuthFromEvent(event)
  const sess = await auth.api.getSession({ headers: event.headers })
  if (sess?.user?.id) {
    const row = (await db.select().from(users).where(eq(users.id, sess.user.id)).limit(1))[0]
    // Conditional plugins in createAuth hide the username plugin's fields from Better Auth's types.
    const { username, displayUsername } = sess.user as AuthIdentity
    const account = { username, displayUsername, email: accountEmail(sess.user) }
    return sessionUser(event, row ?? await ensureDomainUser(event, sess.user), account)
  }
  return null
}

async function ensureAccessIdentity(event: H3Event, identity: CloudflareAccessIdentity): Promise<AuthIdentity> {
  const { env } = cf(event)
  const db = getDb(env.DB)
  const existingServer = (await db.select({ id: server.id }).from(server).limit(1))[0]
  if (!existingServer) {
    const ownerEmail = env.ACCESS_OWNER_EMAIL?.trim().toLowerCase()
    if (!ownerEmail || identity.email !== ownerEmail) fail(403, 'forbidden', 'The server owner must sign in first')
    const username = await generatedUsername(db, identity.email.split('@')[0])
    try {
      await provisionServer(event, {
        userId: identity.id,
        username,
        verifiedEmail: identity.email,
        handle: username,
        displayName: identity.name,
        serverName: (env.ADMIN_SERVER?.trim() || 'L4').slice(0, 80),
      })
    }
    catch (error) {
      const raced = (await db.select({ id: server.id }).from(server).limit(1))[0]
      if (!raced) throw error
    }
    return { ...identity, username }
  }

  // Cloudflare Access is this Server's identity provider and it vouches for the address.
  const byEmail = (await db.select().from(authUsers).where(eq(authUsers.email, identity.email)).limit(1))[0]
  if (byEmail) return { ...identity, id: byEmail.id, username: byEmail.username, displayUsername: byEmail.displayUsername }
  const created = new Date()
  await db.insert(authUsers).values({
    id: identity.id,
    name: identity.name,
    email: identity.email,
    emailVerified: true,
    username: await generatedUsername(db, identity.email.split('@')[0]),
    image: null,
    createdAt: created,
    updatedAt: created,
  }).onConflictDoNothing()
  const stored = (await db.select().from(authUsers).where(eq(authUsers.email, identity.email)).limit(1))[0]
  return { ...identity, id: stored?.id || identity.id, username: stored?.username, displayUsername: stored?.displayUsername }
}

export async function requireUser(event: H3Event): Promise<SessionUser> {
  const user = await currentUser(event)
  if (!user) fail(401, 'unauthorized', 'Login required')
  return user
}

export async function issueWsTicket(event: H3Event, userId: string): Promise<string> {
  const { env } = cf(event)
  const token = bytesToHex(randomBytes(24))
  const session = await (await sessionAuthFromEvent(event)).api.getSession({ headers: event.headers })
  await env.TICKETS.put(`wsticket:${token}`, session ? JSON.stringify({ userId, sessionId: session.session.id }) : userId, { expirationTtl: 120 })
  return token
}
