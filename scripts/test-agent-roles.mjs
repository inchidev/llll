import assert from 'node:assert/strict'
import { Permission, hasPermission } from '../shared/permissions.ts'
import { createFixtureRole } from './test-role-fixture.mjs'

/** Exercise editor role changes against real HTTP, permissions and isolated storage. */
export async function testAgentRoles({ api, runtimes, ids, memberId }) {
  const root = `/api/servers/${ids.alpha}`
  const db = await runtimes.alpha.getD1Database('DB')
  const original = await db.prepare('SELECT role_id FROM users WHERE id=?').bind(memberId).first()
  const admin = await db.prepare("SELECT id,permissions_bitmask FROM roles WHERE key='admin'").first()
  assert.equal(hasPermission(admin.permissions_bitmask, Permission.executeTasks), false)
  const createRole = async (name, permissions, resourceAccess = { boards: ['allowed'] }) =>
    await createFixtureRole({ api, runtimes, ids }, { name, permissions, resourceAccess })
  const base = Permission.sendMessages | Permission.manageAgents
  const profileManager = await createRole('QA agent profile manager', base)
  const roleManager = await createRole('QA agent role manager', base | Permission.manageRoles)
  const limited = await createRole('QA agent limited', Permission.sendMessages)
  const peer = await createRole('QA agent peer', Permission.sendMessages)
  const task = await createRole('QA agent task', Permission.readTasks | Permission.writeTasks | Permission.executeTasks | Permission.sendMessages)
  const wide = await createRole('QA agent outside scope', Permission.sendMessages, { boards: ['private'] })
  let agent
  try {
    agent = (await api('alpha', root + '/agents', { method: 'POST', body: { displayName: 'QA role agent', model: 'fixture-model', roleId: admin.id } })).payload.agent
    assert.equal(agent.roleId, admin.id)
    const edited = (await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', body: { roleId: task.id, status: 'paused' } })).payload.agent
    assert.equal(edited.roleId, task.id)
    assert.equal(edited.status, 'paused')
    const listed = await api('alpha', root + '/agents?page=1&search=QA%20role%20agent')
    assert.equal(listed.payload.agents.find(row => row.id === agent.id).roleId, task.id)
    const all = await api('alpha', root + '/agents')
    assert.equal(all.payload.agents.find(row => row.id === agent.id).roleId, task.id)

    await api('alpha', root + '/members/' + memberId, { method: 'PATCH', body: { roleId: profileManager.id } })
    await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', actor: 'alpha-member', body: { roleId: limited.id, displayName: 'Denied', instructions: 'Denied' }, expected: 403 })
    assert.equal((await db.prepare('SELECT display_name FROM users WHERE id=?').bind(agent.id).first()).display_name, 'QA role agent')
    assert.equal((await db.prepare('SELECT instructions FROM agents WHERE user_id=?').bind(agent.id).first()).instructions, '')
    await api('alpha', root + '/members/' + memberId, { method: 'PATCH', body: { roleId: roleManager.id } })
    for (const current of [task, wide, admin]) {
      await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', body: { roleId: current.id } })
      await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', actor: 'alpha-member', body: { roleId: limited.id }, expected: 403 })
      assert.equal((await db.prepare('SELECT role_id FROM users WHERE id=?').bind(agent.id).first()).role_id, current.id)
    }
    await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', body: { roleId: limited.id } })
    for (const next of [task, wide, admin]) {
      await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', actor: 'alpha-member', body: { roleId: next.id }, expected: 403 })
    }
    await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', actor: 'alpha-member', body: { roleId: peer.id, displayName: 'QA scoped agent' } })
    const owner = await db.prepare("SELECT id FROM roles WHERE key='owner'").first()
    await api('alpha', root + '/agents/' + agent.id, { method: 'PATCH', body: { roleId: owner.id }, expected: 403 })
    assert.equal((await db.prepare('SELECT role_id FROM users WHERE id=?').bind(agent.id).first()).role_id, peer.id)
    assert.equal((await db.prepare("SELECT permissions_bitmask FROM roles WHERE key='admin'").first()).permissions_bitmask, admin.permissions_bitmask)
    const audit = await db.prepare("SELECT meta_json FROM audit_log WHERE action='agent.update' AND target_id=? ORDER BY created_at DESC").bind(agent.id).all()
    assert.ok(audit.results.some(row => { const meta = JSON.parse(row.meta_json); return meta.roleChanged && meta.previousRoleId === admin.id && meta.roleId === task.id }))
    console.log('PASS: agent role editor HTTP roundtrip, directory role IDs, scoped grants, protected Admin/current roles, atomic rejection and unchanged built-in autonomy policy')
  } finally {
    await api('alpha', root + '/members/' + memberId, { method: 'PATCH', body: { roleId: original.role_id } })
    if (agent) await api('alpha', root + '/members/' + agent.id, { method: 'DELETE' })
    for (const role of [profileManager, roleManager, limited, peer, task, wide]) await api('alpha', root + '/roles/' + role.id, { method: 'DELETE' })
  }
}
