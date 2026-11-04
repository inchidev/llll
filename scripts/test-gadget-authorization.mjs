import assert from 'node:assert/strict'
import { Permission } from '../shared/permissions.ts'
import { createFixtureRole } from './test-role-fixture.mjs'

export async function testGadgetAuthorization({ api, runtimes, ids, memberId }) {
  const root = `/api/servers/${ids.alpha}`
  const db = await runtimes.alpha.getD1Database('DB')
  const original = await db.prepare('SELECT role_id FROM users WHERE id=?').bind(memberId).first()
  const owner = await db.prepare('SELECT owner_id FROM server').first()
  const allowedId = crypto.randomUUID(), privateId = crypto.randomUUID()
  await db.batch([allowedId, privateId].map(id => db.prepare('INSERT INTO database_definitions(id,name,created_by) VALUES(?,?,?)').bind(id, id === allowedId ? 'QA allowed source' : 'QA private source', owner.owner_id)))
  const role = await createFixtureRole({ api, runtimes, ids }, { name: 'QA scoped App manager', permissions: Permission.manageGadgets | Permission.manageDatabases, resourceAccess: { databases: [allowedId] } })
  const spec = databaseId => ({ schemaVersion: 1, bindings: [{ id: 'source', label: 'Source', source: { type: 'database_view', databaseId, viewId: `default:${databaseId}` }, fieldIds: [], operations: ['read'] }], sections: [{ id: 'section', bindingId: 'source', title: 'Source', presentation: 'table' }] })
  try {
    await api('alpha', `${root}/members/${memberId}`, { method: 'PATCH', body: { roleId: role.id } })
    await api('alpha', root + '/gadgets', { method: 'POST', actor: 'alpha-member', body: { name: 'Denied source', spec: spec(privateId) }, expected: 403 })
    const allowed = (await api('alpha', root + '/gadgets', { method: 'POST', actor: 'alpha-member', body: { name: 'Allowed source', spec: spec(allowedId) } })).payload.gadget
    await api('alpha', `/api/gadgets/${allowed.id}/publish`, { method: 'POST', actor: 'alpha-member', body: { revision: allowed.draftRevision } })
    const other = (await api('alpha', root + '/gadgets', { method: 'POST', body: { name: 'Private owner draft', spec: spec(privateId) } })).payload.gadget
    await api('alpha', `/api/gadgets/${other.id}`, { method: 'PATCH', actor: 'alpha-member', body: { revision: other.draftRevision, name: 'Take over' }, expected: 403 })
    await api('alpha', `/api/gadgets/${other.id}/publish`, { method: 'POST', actor: 'alpha-member', body: { revision: other.draftRevision }, expected: 403 })
    assert.equal((await db.prepare('SELECT name FROM gadgets WHERE id=?').bind(other.id).first()).name, 'Private owner draft')
    await api('alpha', `/api/gadgets/${other.id}`, { actor: 'alpha-member', expected: 403 })
    await api('alpha', `/api/gadgets/${other.id}/publish`, { method: 'POST', body: { revision: other.draftRevision } })
    await api('alpha', `/api/gadgets/${other.id}/runtime`, { actor: 'alpha-member', expected: 403 })
    const granted = (await api('alpha', `/api/gadgets/${other.id}`, { method: 'PATCH', body: { revision: other.draftRevision, roleIds: [role.id] } })).payload.gadget
    await api('alpha', `/api/gadgets/${other.id}/publish`, { method: 'POST', body: { revision: granted.draftRevision } })
    await api('alpha', `/api/gadgets/${other.id}/runtime`, { actor: 'alpha-member' })
    console.log('PASS: authenticated scoped App manager cannot bind, modify or publish private sources; authorized source publishing succeeds')
  } finally {
    await api('alpha', `${root}/members/${memberId}`, { method: 'PATCH', body: { roleId: original.role_id } })
    await api('alpha', `${root}/roles/${role.id}`, { method: 'DELETE' })
  }
}
