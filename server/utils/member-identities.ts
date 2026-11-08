import { and, eq, isNull, or } from 'drizzle-orm'
import { authAccounts, authSessions, authUsers, mcpAccessTokens, memberIdentities, roles, server, users } from '../../drizzle/schema'
import type { MemberIdentity } from '../../shared/cloud-seed'
import { newId, nowIso } from '../../shared/ids'
import { signalMembersChanged } from '../../workers/member-events'
import type { L4Env } from '../../workers/env'
import { generatedUsername, placeholderEmail } from './account-identity'
import { fail } from './cf'
import { getDb } from './db'
import { revalidateLiveRooms } from './live'
import { assertHumanNameAvailable } from './member-names'
import { writeAudit } from './messages'
import { hashPassword } from './password'

/**
 * A Member named by an outside identity (ADR 0012): the partner's account on its side, one row here. Nothing is
 * linked by email; the row is the only link, and it is written by the Server when the Owner claims or when the
 * control plane asks for a Member.
 */
export async function findMemberByIdentity(env: L4Env, identity: MemberIdentity) {
  const db = getDb(env.DB)
  return (await db.select({ id: users.id, status: users.status, displayName: users.displayName, kind: users.kind })
    .from(memberIdentities).innerJoin(users, eq(users.id, memberIdentities.userId))
    .where(and(eq(memberIdentities.provider, identity.provider), eq(memberIdentities.subject, identity.subject))).limit(1))[0] ?? null
}

/** Links an identity to a Member. An identity already linked to another Member is refused: identities are not moved. */
export async function recordMemberIdentity(env: L4Env, identity: MemberIdentity, userId: string) {
  const db = getDb(env.DB)
  await db.insert(memberIdentities).values({ provider: identity.provider, subject: identity.subject, userId, createdAt: nowIso() }).onConflictDoNothing()
  const row = (await db.select({ userId: memberIdentities.userId }).from(memberIdentities)
    .where(and(eq(memberIdentities.provider, identity.provider), eq(memberIdentities.subject, identity.subject))).limit(1))[0]
  if (row?.userId !== userId) fail(409, 'identity_taken', 'This identity already names another Member')
}

const randomPassword = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * A human Member for an identity: active, in the Server's default Space, with the `member` Role, no email and a
 * password nobody is told. One that exists keeps its Account and takes the new name; one removed earlier is
 * admitted again. The Owner is never made here.
 */
export async function upsertPartnerMember(env: L4Env, input: { serverId: string; actorId: string; identity: MemberIdentity; name: string }) {
  const db = getDb(env.DB)
  const name = input.name.trim().slice(0, 80) || 'Member'
  const existing = await findMemberByIdentity(env, input.identity)
  const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
  if (!memberRole) fail(409, 'server_incomplete', 'Member role not found')
  const now = nowIso()
  if (existing) {
    if (existing.kind !== 'human') fail(409, 'not_a_member', 'This identity names an Agent')
    await assertHumanNameAvailable(env, name, existing.id)
    const owner = (await db.select({ ownerId: server.ownerId }).from(server).limit(1))[0]
    const readmitted = existing.status !== 'active' && existing.id !== owner?.ownerId
    await db.batch([
      db.update(users).set({ displayName: name, updatedAt: now, ...(readmitted ? { status: 'active', roleId: memberRole.id, joinedAt: now } : {}) }).where(eq(users.id, existing.id)),
      db.update(authUsers).set({ name, updatedAt: new Date(now) }).where(eq(authUsers.id, existing.id)),
    ])
    if (readmitted) {
      await writeAudit(env, { serverId: input.serverId, actorId: input.actorId, action: 'member.join', targetType: 'user', targetId: existing.id, meta: { admission: 'partner' } })
      await signalMembersChanged(env, input.serverId)
    }
    return { userId: existing.id, created: false }
  }

  await assertHumanNameAvailable(env, name, '')
  const id = newId()
  const username = await generatedUsername(db, name)
  const handleTaken = (await db.select({ id: users.id }).from(users).where(eq(users.handle, username)).limit(1))[0]
  const created = new Date(now)
  await db.batch([
    db.insert(authUsers).values({ id, name, email: placeholderEmail(id), emailVerified: false, username, displayUsername: username, pendingEmail: null, image: null, createdAt: created, updatedAt: created }),
    db.insert(authAccounts).values({ id: newId(), accountId: id, providerId: 'credential', userId: id, password: await hashPassword(randomPassword()), createdAt: created, updatedAt: created }),
    db.insert(users).values({ id, kind: 'human', handle: handleTaken ? null : username, displayName: name, avatarR2Key: null, status: 'active', roleId: memberRole.id, nickname: null, joinedAt: now, createdAt: now, updatedAt: now }),
    db.insert(memberIdentities).values({ provider: input.identity.provider, subject: input.identity.subject, userId: id, createdAt: now }),
  ])
  await writeAudit(env, { serverId: input.serverId, actorId: input.actorId, action: 'member.join', targetType: 'user', targetId: id, meta: { admission: 'partner' } })
  await signalMembersChanged(env, input.serverId)
  return { userId: id, created: true }
}

/**
 * Removes the Member an identity names, as the Owner would from Members: `removed`, no Role, every session and
 * token gone. The Owner's identity is refused. An identity that names nobody changes nothing.
 */
export async function removePartnerMember(env: L4Env, input: { serverId: string; actorId: string; identity: MemberIdentity }) {
  const db = getDb(env.DB)
  const existing = await findMemberByIdentity(env, input.identity)
  if (!existing) return { userId: null, removed: false }
  const owner = (await db.select({ ownerId: server.ownerId }).from(server).limit(1))[0]
  if (existing.id === owner?.ownerId) fail(409, 'owner', 'The Owner cannot be removed')
  if (existing.status !== 'active') return { userId: existing.id, removed: false }
  const now = nowIso()
  await db.batch([
    db.update(users).set({ status: 'removed', roleId: null, nickname: null, joinedAt: null, updatedAt: now }).where(eq(users.id, existing.id)),
    db.delete(authSessions).where(eq(authSessions.userId, existing.id)),
    db.update(mcpAccessTokens).set({ revokedAt: now, updatedAt: now }).where(and(isNull(mcpAccessTokens.revokedAt), or(eq(mcpAccessTokens.subjectId, existing.id), eq(mcpAccessTokens.createdBy, existing.id)))),
  ])
  await writeAudit(env, { serverId: input.serverId, actorId: input.actorId, action: 'member.kick', targetType: 'user', targetId: existing.id, meta: { partner: true } })
  await signalMembersChanged(env, input.serverId)
  await revalidateLiveRooms(env)
  return { userId: existing.id, removed: true }
}
