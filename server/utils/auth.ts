import { getServerId } from '../../shared/server-id'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { authUsers, roles, users, workspace } from '../../drizzle/schema'
import type { PublicUser, SessionUser } from '../../shared/types'
import { nowIso } from '../../shared/ids'
import { sessionAuthFromEvent } from './better-auth'
import { loadAuthRuntimeConfig } from './auth-config'
import { authMode, cloudflareAccessIdentity, type CloudflareAccessIdentity } from './cloudflare-access'
import { provisionWorkspace } from './bootstrap'
import { cf, fail } from './cf'
import { getDb } from './db'
import { writeAudit } from './messages'
import { signalMembersChanged } from '../../workers/member-events'
import {
  consumeSocialOnboardingTicket,
  hasAcceptedCurrentOnboarding,
  loadCurrentOnboarding,
  recordOnboardingAcceptance,
} from './onboarding'

type AuthIdentity = { id: string; email: string; name: string; image?: string | null }

export function visibleAuthEmail(email: string): string | null {
  return email.endsWith('@identity.llll.invalid') ? null : email
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
  await db.insert(users).values({
    id: identity.id,
    displayName: identity.name || visibleAuthEmail(identity.email)?.split('@')[0] || 'member',
    avatarR2Key: identity.image ?? null,
    status: active ? 'active' : 'pending',
    roleId: memberRole?.id ?? null,
    nickname: null,
    joinedAt: active ? created : null,
    createdAt: created,
    updatedAt: created,
  }).onConflictDoNothing()
  row = (await db.select().from(users).where(eq(users.id, identity.id)).limit(1))[0]!
  if (active) {
    await writeAudit(env, {
      workspaceId: await getServerId(env.DB),
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
  email: string | null,
): Promise<SessionUser> {
  const { env } = cf(event)
  return {
    ...publicUser(row),
    email,
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
    workspaceId: await getServerId(env.DB),
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
  if (authMode(env) === 'access') {
    const accessIdentity = await cloudflareAccessIdentity(event)
    if (!accessIdentity) return null
    const identity = await ensureAccessIdentity(event, accessIdentity)
    const row = (await db.select().from(users).where(eq(users.id, identity.id)).limit(1))[0]
      || await ensureDomainUser(event, identity)
    return sessionUser(event, row, identity.email)
  }
  const auth = await sessionAuthFromEvent(event)
  const sess = await auth.api.getSession({ headers: event.headers })
  if (sess?.user?.id) {
    const row = (await db.select().from(users).where(eq(users.id, sess.user.id)).limit(1))[0]
    if (row) return sessionUser(event, row, visibleAuthEmail(sess.user.email))
    const createdRow = await ensureDomainUser(event, sess.user)
    return sessionUser(event, createdRow, visibleAuthEmail(sess.user.email))
  }
  return null
}

async function ensureAccessIdentity(event: H3Event, identity: CloudflareAccessIdentity): Promise<AuthIdentity> {
  const { env } = cf(event)
  const db = getDb(env.DB)
  const existingWorkspace = (await db.select({ id: workspace.id }).from(workspace).limit(1))[0]
  if (!existingWorkspace) {
    const ownerEmail = env.ADMIN_EMAIL?.trim().toLowerCase()
    if (!ownerEmail || identity.email !== ownerEmail) fail(403, 'forbidden', 'The workspace owner must sign in first')
    try {
      await provisionWorkspace(event, {
        userId: identity.id,
        email: identity.email,
        handle: (identity.email.split('@')[0] || 'owner').slice(0, 32),
        displayName: identity.name,
        workspaceName: (env.ADMIN_WORKSPACE?.trim() || env.APP_NAME?.trim() || 'L4').slice(0, 80),
      })
    }
    catch (error) {
      const raced = (await db.select({ id: workspace.id }).from(workspace).limit(1))[0]
      if (!raced) throw error
    }
    return identity
  }

  const byEmail = (await db.select().from(authUsers).where(eq(authUsers.email, identity.email)).limit(1))[0]
  if (byEmail) return { ...identity, id: byEmail.id }
  const created = new Date()
  await db.insert(authUsers).values({
    id: identity.id,
    name: identity.name,
    email: identity.email,
    emailVerified: true,
    image: null,
    createdAt: created,
    updatedAt: created,
  }).onConflictDoNothing()
  const stored = (await db.select().from(authUsers).where(eq(authUsers.email, identity.email)).limit(1))[0]
  return { ...identity, id: stored?.id || identity.id }
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
