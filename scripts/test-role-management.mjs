import assert from 'node:assert/strict'
import { Permission, MemberPermissions } from '../shared/permissions.ts'
import { createFixtureRole } from './test-role-fixture.mjs'

/** Exercise management guards over real authenticated HTTP with an isolated D1. */
export async function testRoleManagement({ api, runtimes, ids, memberId }) {
  const root = `/api/servers/${ids.alpha}`
  const db = await runtimes.alpha.getD1Database('DB')
  const original = await db.prepare('SELECT role_id FROM users WHERE id=?').bind(memberId).first()
  const perms = MemberPermissions | Permission.manageRoles | Permission.kick
  const create = async (name, permissions, resourceAccess = {}) => await createFixtureRole({ api, runtimes, ids }, { name, permissions, resourceAccess })
  const actor = await create('QA manager', perms, { boards: ['allowed'] })
  const strong = await create('QA privileged', perms | Permission.executeTasks, { boards: ['allowed'] })
  const wide = await create('QA private resources', MemberPermissions, { boards: ['private'] })
  const weak = await create('QA controlled', MemberPermissions, { boards: ['allowed'] })
  const target = crypto.randomUUID()
  await db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES(?,'human','QA target','active',?,?)").bind(target, strong.id, new Date().toISOString()).run()
  try {
    await api('alpha', `${root}/members/${memberId}`, { method: 'PATCH', body: { roleId: actor.id } })
    const admin = await db.prepare("SELECT id FROM roles WHERE key='admin'").first()
    for (const role of [strong, wide, admin]) {
      await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(role.id, target).run()
      await api('alpha', `${root}/members/${target}`, { method: 'PATCH', actor: 'alpha-member', body: { roleId: weak.id }, expected: 403 })
      await api('alpha', `${root}/members/${target}`, { method: 'DELETE', actor: 'alpha-member', expected: 403 })
      assert.equal((await db.prepare('SELECT role_id FROM users WHERE id=?').bind(target).first()).role_id, role.id)
    }
    for (const role of [strong, wide]) {
      await api('alpha', `${root}/roles/${role.id}`, { method: 'PATCH', actor: 'alpha-member', body: { name: 'QA takeover' }, expected: 403 })
      await api('alpha', `${root}/roles/${role.id}`, { method: 'DELETE', actor: 'alpha-member', expected: 403 })
    }
    await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(weak.id, target).run()
    await api('alpha', `${root}/roles/${weak.id}`, { method: 'PATCH', actor: 'alpha-member', body: { name: 'QA renamed' } })
    await api('alpha', `${root}/members/${target}`, { method: 'PATCH', actor: 'alpha-member', body: { roleId: actor.id } })
    await api('alpha', `${root}/members/${target}`, { method: 'DELETE', actor: 'alpha-member' })
    await api('alpha', `${root}/members/${target}`, { method: 'DELETE', actor: 'alpha-member', expected: 404 })
    // Deletion must also authorize the fallback member role, which is unrestricted.
    await api('alpha', `${root}/roles/${weak.id}`, { method: 'DELETE', actor: 'alpha-member', expected: 403 })
    await db.prepare("UPDATE roles SET resource_access_json='{}' WHERE id=?").bind(actor.id).run()
    await api('alpha', `${root}/roles/${weak.id}`, { method: 'DELETE', actor: 'alpha-member' })
    console.log('PASS: authenticated role/member management rejects stronger current permissions, resources and admin targets; scoped allowed paths, fallback protection and inactive-target rejection')
  } finally {
    await api('alpha', `${root}/members/${memberId}`, { method: 'PATCH', body: { roleId: original.role_id } })
    for (const role of [strong, wide, actor]) await api('alpha', `${root}/roles/${role.id}`, { method: 'DELETE' })
  }
}
