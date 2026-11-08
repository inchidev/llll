import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import { ensureFirstBoard } from './project-service'
import { getServerId } from '../../shared/server-id'
import type { H3Event } from 'h3'
import { ALL_PERMISSIONS, MemberPermissions, Permission } from '../../shared/permissions'
import { newId, nowIso } from '../../shared/ids'
import { authAccounts, authUsers, auditLog, channelCategories, channels, roles, users, server } from '../../drizzle/schema'
import { cf } from './cf'
import { ensureMigrated, getDb, userCount } from './db'
import { hashPassword } from './password'
import type { L4Env } from '../../workers/env'
import { ensureServerMailFromEnv } from './server-mail'
import { migrateLegacySettings } from './legacy-settings'
import { isUsername, normalizeUsername } from '../../shared/account'
import { placeholderEmail } from './account-identity'

export type AdminSeed = {
  userId?: string
  username: string
  /** An address already proven, as Cloudflare Access proves one. Otherwise the Account starts without email. */
  verifiedEmail?: string
  /** An address the Owner typed: stored unconfirmed until its link is opened. */
  pendingEmail?: string
  password?: string
  handle: string
  displayName: string
  serverName: string
}

export function readAdminEnv(env: Pick<L4Env, 'ADMIN_USERNAME' | 'ADMIN_PASSWORD' | 'ADMIN_NAME' | 'ADMIN_HANDLE' | 'ADMIN_SERVER'>): AdminSeed | null {
  const username = env.ADMIN_USERNAME?.trim().toLowerCase() || ''
  const password = env.ADMIN_PASSWORD || ''
  if (!isUsername(username) || password.length < 8) return null
  const handle = (env.ADMIN_HANDLE?.trim() || username).slice(0, 32)
  const displayName = (env.ADMIN_NAME?.trim() || handle).slice(0, 80)
  const serverName = (env.ADMIN_SERVER?.trim() || 'HQ').slice(0, 80)
  return { username, password, handle, displayName, serverName }
}

export async function provisionServer(event: H3Event, seed: AdminSeed) {
  return provisionServerWithEnv(cf(event).env, seed)
}

/** The same bootstrap without a request: the L4 Cloud relay creates a partner's Owner this way (ADR 0012). */
export async function provisionServerWithEnv(env: L4Env, seed: AdminSeed) {
  const db = getDb(env.DB)
  const userId = seed.userId || newId()
  const accountId = newId()
  const serverId = (await getServerId(env.DB))
  const ownerRoleId = newId()
  const adminRoleId = newId()
  const memberRoleId = newId()
  const channelsCategoryId = newId()
  const generalId = newId()
  const randomId = newId()
  const auditId = newId()
  const created = nowIso()
  const authCreated = new Date(created)
  const passwordHash = seed.password ? await hashPassword(seed.password) : null

  const authUserStatement = db.insert(authUsers).values({
    id: userId,
    name: seed.displayName,
    email: seed.verifiedEmail ?? placeholderEmail(userId),
    emailVerified: Boolean(seed.verifiedEmail),
    username: normalizeUsername(seed.username),
    displayUsername: seed.username,
    pendingEmail: seed.pendingEmail ?? null,
    image: null,
    createdAt: authCreated,
    updatedAt: authCreated,
  })
  const statements = [
    db.insert(roles).values([
      { id: ownerRoleId, key: 'owner', name: 'owner', permissionsBitmask: ALL_PERMISSIONS, position: 0, isSystem: true, createdAt: created, updatedAt: created },
      { id: adminRoleId, key: 'admin', name: 'admin', permissionsBitmask: ALL_PERMISSIONS & ~(Permission.mcpConnect | Permission.executeTasks | Permission.useComputer | Permission.manageSchedules | Permission.proposeCode), position: 1, isSystem: true, createdAt: created, updatedAt: created },
      { id: memberRoleId, key: 'member', name: 'member', permissionsBitmask: MemberPermissions, position: 2, isSystem: true, createdAt: created, updatedAt: created },
    ]),
    db.insert(users).values({
      id: userId,
      handle: seed.handle,
      displayName: seed.displayName,
      avatarR2Key: null,
      status: 'active',
      roleId: ownerRoleId,
      nickname: null,
      joinedAt: created,
      createdAt: created,
      updatedAt: created,
    }),
    db.insert(server).values({
      id: serverId,
      name: seed.serverName,
      iconR2Key: null,
      ownerId: userId,
      createdAt: created,
      updatedAt: created,
    }),
    db.insert(channelCategories).values({
      id: channelsCategoryId,
      name: 'Channels',
      position: 0,
      createdAt: created,
      updatedAt: created,
    }),
    db.insert(channels).values([
      { id: generalId, name: 'general', topic: '', type: 'text', visibility: 'server', categoryId: channelsCategoryId, position: 0, liveMeetingId: null, parentId: null, parentMessageId: null, createdAt: created, updatedAt: created },
      { id: randomId, name: 'random', topic: '', type: 'text', visibility: 'server', categoryId: channelsCategoryId, position: 1, liveMeetingId: null, parentId: null, parentMessageId: null, createdAt: created, updatedAt: created },
    ]),
    db.insert(auditLog).values({
      id: auditId,
      actorId: userId,
      action: 'server.create',
      targetType: 'server',
      targetId: serverId,
      metaJson: JSON.stringify({ name: seed.serverName }),
      createdAt: created,
    }),
  ]
  if (passwordHash) {
    const accountStatement = db.insert(authAccounts).values({
      id: accountId,
      accountId: userId,
      providerId: 'credential',
      userId,
      password: passwordHash,
      createdAt: authCreated,
      updatedAt: authCreated,
    })
    await db.batch([authUserStatement, accountStatement, ...statements] as unknown as Parameters<typeof db.batch>[0])
  }
  else {
    await db.batch([authUserStatement, ...statements] as unknown as Parameters<typeof db.batch>[0])
  }

  // The first Space's board: Tasks have somewhere to go from the start.
  await ensureFirstBoard(env, DEFAULT_SPACE_ID, userId)

  return { userId, serverId, channelId: generalId }
}

// Deployment variables only change with a new deployment (and a new isolate),
// so once the server exists and mail is synced there is nothing left to do.
let bootstrappedInIsolate = false

export async function ensureAdminFromEnv(event: H3Event): Promise<{ users: number; provisioned: boolean }> {
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  await migrateLegacySettings(env)
  const users = await userCount(env.DB)
  if (users > 0) {
    if (!bootstrappedInIsolate) {
      await ensureServerMailFromEnv(env)
      bootstrappedInIsolate = true
    }
    return { users, provisioned: false }
  }
  const seed = readAdminEnv(env)
  if (!seed) return { users: 0, provisioned: false }
  await provisionServer(event, seed)
  await ensureServerMailFromEnv(env)
  return { users: 1, provisioned: true }
}
