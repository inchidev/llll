/**
 * A custom Role for integration fixtures, built the way the product builds one: an empty
 * Role plus a reusable policy carrying its permissions. Resource limits have no HTTP editor
 * now, so a requested limit is written to the isolated test database directly.
 */
export async function createFixtureRole({ api, runtimes, ids }, { name, permissions = 0, resourceAccess }) {
  const root = `/api/servers/${ids.alpha}`
  const role = (await api('alpha', root + '/roles', { method: 'POST', body: { name } })).payload.role
  const policy = (await api('alpha', root + '/project-policies', { method: 'POST', body: { name: `${name} permissions`, permissions } })).payload.policy
  await api('alpha', `${root}/roles/${role.id}/policies`, { method: 'PUT', body: { policyIds: [policy.id] } })
  if (resourceAccess && Object.keys(resourceAccess).length) {
    const db = await runtimes.alpha.getD1Database('DB')
    await db.prepare('UPDATE roles SET resource_access_json=? WHERE id=?').bind(JSON.stringify(resourceAccess), role.id).run()
  }
  return { ...role, permissions, resourceAccess: resourceAccess ?? {} }
}

/** Replace a fixture Role's permissions by assigning it a fresh policy. */
export async function setFixtureRolePermissions({ api, ids }, roleId, permissions) {
  const root = `/api/servers/${ids.alpha}`
  const policy = (await api('alpha', root + '/project-policies', { method: 'POST', body: { name: `Fixture ${roleId.slice(0, 8)} ${permissions}`, permissions } })).payload.policy
  await api('alpha', `${root}/roles/${roleId}/policies`, { method: 'PUT', body: { policyIds: [policy.id] } })
}
