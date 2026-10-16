import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { authUsers, roles, users, workspace } from '../../drizzle/schema'
import { verifyInstallationIdentity } from '../../shared/installation-identity'
import { nowIso } from '../../shared/ids'
import { cf, fail } from './cf'
import { ensureMigrated, getDb } from './db'
import { provisionWorkspace } from './bootstrap'
import { hasAcceptedCurrentOnboarding } from './onboarding'

/** A signature admits an installation identity; the local server still owns roles and removals. */
export async function installationUser(event: H3Event) {
  const token = getHeader(event, 'x-llll-identity')
  if (!token) return null
  const { env } = cf(event)
  if (!env.LLLL_INSTALLATION_ORIGIN || !env.LLLL_INSTALLATION_KEY || !env.LLLL_SERVER_ID) fail(401, 'installation_unbound', 'This server does not trust an installation')
  let identity
  try { identity = await verifyInstallationIdentity(token, env.LLLL_INSTALLATION_KEY, env.LLLL_INSTALLATION_ORIGIN, env.LLLL_SERVER_ID) }
  catch { fail(401, 'installation_identity', 'Installation identity expired or could not be verified') }
  await ensureMigrated(env.DB, env)
  const db = getDb(env.DB)
  if (!(await db.select({ id: workspace.id }).from(workspace).limit(1))[0]) {
    if ((identity.sub !== env.LLLL_SERVER_OWNER_ID && env.LLLL_ALLOW_INSTALLATION_BOOTSTRAP !== 'true') || identity.role !== 'owner') fail(409, 'owner_setup', 'The server owner must open this server first')
    try {
      await provisionWorkspace(event, { userId: identity.sub, email: identity.email, displayName: identity.name, handle: `owner-${identity.sub.slice(0, 8)}`, workspaceName: env.ADMIN_WORKSPACE || env.APP_NAME || 'L4' })
    }
    catch (error) {
      if (!(await db.select({ id: workspace.id }).from(workspace).limit(1))[0]) throw error
    }
  }
  let row = (await db.select().from(users).where(eq(users.id, identity.sub)).limit(1))[0]
  if (!row) {
    const existingAuth = (await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, identity.email)).limit(1))[0]
    if (existingAuth && existingAuth.id !== identity.sub) fail(409, 'identity_conflict', 'This email belongs to a local account. Link it explicitly before connecting.')
    const created = nowIso()
    const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
    if (!memberRole) fail(503, 'role_unavailable', 'Server member role is unavailable')
    const admitted = await hasAcceptedCurrentOnboarding(env, identity.sub)
    await db.batch([
      db.insert(authUsers).values({ id: identity.sub, name: identity.name, email: identity.email, emailVerified: false, createdAt: new Date(created), updatedAt: new Date(created) }).onConflictDoNothing(),
      db.insert(users).values({ id: identity.sub, kind: 'human', displayName: identity.name, status: admitted ? 'active' : 'pending', roleId: memberRole.id, joinedAt: admitted ? created : null, createdAt: created, updatedAt: created }).onConflictDoNothing(),
    ])
    row = (await db.select().from(users).where(eq(users.id, identity.sub)).limit(1))[0]
  }
  if (!row) fail(409, 'identity_conflict', 'The local account needs explicit linking')
  if (row.status === 'pending' && await hasAcceptedCurrentOnboarding(env, identity.sub)) {
    const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
    if (memberRole) {
      await db.update(users).set({ status: 'active', roleId: memberRole.id, joinedAt: nowIso(), updatedAt: nowIso() }).where(eq(users.id, identity.sub))
      row = (await db.select().from(users).where(eq(users.id, identity.sub)).limit(1))[0]!
    }
  }
  return { row, email: identity.email }
}
