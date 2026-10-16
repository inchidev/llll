import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import type { GadgetSpec } from '../../shared/gadgets'
import { INIT_SQL } from '../../server/utils/db'
import { createGadget, listGadgets, publishGadget, updateGadget } from '../../server/utils/gadget-catalog'
import { composeGadgetSpec } from '../../server/utils/gadget-composer'
import { invokeGadget, openGadget } from '../../server/utils/gadget-runtime'
import { parseGadgetSpec, validateGadgetSpec } from '../../server/utils/gadget-spec'
import type { Membership } from '../../server/utils/guards'

beforeAll(() => vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string; data: unknown }) => Object.assign(new Error(input.statusMessage), input)))
afterAll(() => vi.unstubAllGlobals())

function d1(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string) {
    let values: SQLInputValue[] = []
    const statement = {
      sql,
      bind(...next: SQLInputValue[]) { values = next; return statement },
      async first<T>() { return sqlite.prepare(sql).get(...values) as T | null },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] } },
      async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) } },
    }
    return statement
  }
  return {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      const results = []
      for (const statement of statements) {
        results.push(/^\s*SELECT\b/iu.test(statement.sql) ? await statement.all() : await statement.run())
      }
      return results
    },
  } as unknown as D1Database
}

function actor(overrides: Partial<Membership> = {}): Membership {
  const base: Membership = {
    user: { id: 'owner', kind: 'human', displayName: 'Owner', avatarR2Key: null },
    workspaceId: 'main',
    roleId: 'owner-role',
    roleName: 'Owner',
    perms: ALL_PERMISSIONS,
    ownerId: 'owner',
    isOwner: true,
    authorization: {
      workspaceId: 'main',
      principal: { id: 'owner', kind: 'human', roleId: 'owner-role', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true },
      credential: { kind: 'session' },
    },
  }
  return { ...base, ...overrides }
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES
      ('owner-role', 'owner', 'Owner', ${ALL_PERMISSIONS}),
      ('member-role', 'member', 'Member', ${Permission.useGadgets}),
      ('reviewer-role', 'custom', 'Reviewer', ${Permission.useGadgets});
    INSERT INTO identity_keys (id, name, email) VALUES
      ('owner', 'Owner', 'owner@example.com'),
      ('member', 'Member', 'member@example.com');
    INSERT INTO users (id, kind, display_name, status, role_id, joined_at) VALUES
      ('owner', 'human', 'Owner', 'active', 'owner-role', CURRENT_TIMESTAMP),
      ('member', 'human', 'Member', 'active', 'member-role', CURRENT_TIMESTAMP);
    INSERT INTO workspace (id, name, owner_id) VALUES ('main', 'Workspace', 'owner');
    INSERT INTO database_definitions (id, name, created_by) VALUES
      ('leads', 'Leads', 'owner'),
      ('companies', 'Companies', 'owner');
    INSERT INTO database_fields (id, database_id, name, type, slot, config_json, created_by) VALUES
      ('lead-status', 'leads', 'Status', 'select', 'select_1', '{"options":["Open","Won"]}', 'owner'),
      ('lead-secret', 'leads', 'Secret', 'text', 'text_1', '{}', 'owner'),
      ('company-tier', 'companies', 'Tier', 'text', 'text_1', '{}', 'owner');
    INSERT INTO database_items (id, database_id, title, select_1, text_1, created_by) VALUES ('lead-1', 'leads', 'Acme deal', 'Open', 'Private note', 'owner');
    INSERT INTO database_items (id, database_id, title, text_1, created_by) VALUES ('company-1', 'companies', 'Acme', 'Enterprise', 'owner');
  `)
  return sqlite
}

const spec: GadgetSpec = {
  schemaVersion: 1,
  bindings: [{
    id: 'leads',
    label: 'Leads / All records',
    source: { type: 'database_view', databaseId: 'leads', viewId: 'default:leads' },
    fieldIds: ['lead-status'],
    operations: ['read', 'create', 'update'],
  }, {
    id: 'companies',
    label: 'Companies / All records',
    source: { type: 'database_view', databaseId: 'companies', viewId: 'default:companies' },
    fieldIds: ['company-tier'],
    operations: ['read'],
  }],
  sections: [
    { id: 'pipeline', bindingId: 'leads', title: 'Pipeline', presentation: 'table' },
    { id: 'accounts', bindingId: 'companies', title: 'Accounts', presentation: 'list' },
  ],
}

describe('Gadgets', () => {
  it('accepts multiple explicit Database View Bindings and rejects ambient capabilities', async () => {
    const sqlite = fixture()
    await expect(validateGadgetSpec({ DB: d1(sqlite) } as never, spec, { publish: true })).resolves.toEqual(spec)
    expect(() => parseGadgetSpec({ ...spec, bindings: [{ ...spec.bindings[0], operations: ['create'] }] })).toThrow('Every App Binding must allow read access')
    expect(() => parseGadgetSpec({ ...spec, sections: [{ ...spec.sections[0], bindingId: 'missing' }] })).toThrow('Every App Section must reference a Binding')
    sqlite.exec("DELETE FROM database_fields WHERE id = 'company-tier'")
    await expect(validateGadgetSpec({ DB: d1(sqlite) } as never, spec, { publish: true })).rejects.toThrow('missing or hidden Field')
    sqlite.close()
  })

  it('lets Jev select and rank prepared sources without sending Record values', async () => {
    const sqlite = fixture()
    let sent: Record<string, unknown> | undefined
    const generated = await composeGadgetSpec({
      DB: d1(sqlite),
      AI: {
        async run(_model: string, input: Record<string, unknown>) {
          sent = input
          return { answers: {
            include_0: { noul: 0.9 }, presentation_0: { choice: 'table' }, priority_0: { score: 1 },
            include_1: { noul: 0.9 }, presentation_1: { choice: 'list' }, priority_1: { score: 2 },
          } }
        },
      },
    } as never, 'Combine companies and leads')
    expect(generated.bindings.map(binding => binding.source.databaseId)).toEqual(['companies', 'leads'])
    expect(generated.sections.map(section => section.presentation)).toEqual(['list', 'table'])
    expect(JSON.stringify(sent)).not.toContain('Acme deal')
    expect(JSON.stringify(sent)).not.toContain('Enterprise')
    sqlite.close()
  })

  it('publishes an immutable multi-database runtime and enforces Binding operations', async () => {
    const sqlite = fixture()
    const env = { DB: d1(sqlite) } as never
    const manager = actor()
    const created = await createGadget(env, manager, { name: 'Sales desk', spec, roleIds: ['member-role'] })
    const published = await publishGadget(env, manager, created.id, created.draftRevision)
    expect(published.publishedVersion).toBe(1)

    const member = actor({
      user: { id: 'member', kind: 'human', displayName: 'Member', avatarR2Key: null },
      roleId: 'member-role', roleName: 'Member', perms: Permission.useGadgets, isOwner: false,
      authorization: {
        workspaceId: 'main',
        principal: { id: 'member', kind: 'human', roleId: 'member-role', roleName: 'Member', permissions: Permission.useGadgets, isOwner: false },
        credential: { kind: 'session' },
      },
    })
    const catalog = await listGadgets(env, member)
    expect(catalog.gadgets.map(gadget => gadget.name)).toEqual(['Sales desk'])
    const runtime = await openGadget(env, member, created.id)
    expect(runtime.datasets.map(dataset => dataset.database.name)).toEqual(['Leads', 'Companies'])
    expect(runtime.datasets[0]?.items[0]?.values).toEqual({ 'lead-status': 'Open' })
    expect(runtime.datasets[1]?.items[0]?.values).toEqual({ 'company-tier': 'Enterprise' })

    const item = await invokeGadget(env, member, created.id, {
      bindingId: 'leads', operation: 'create', title: 'Beta deal', values: { 'lead-status': 'Won' },
    })
    expect(item).toMatchObject({ databaseId: 'leads', title: 'Beta deal', values: { 'lead-status': 'Won' } })
    expect(item.values).toEqual({ 'lead-status': 'Won' })
    const updated = await invokeGadget(env, member, created.id, {
      bindingId: 'leads', operation: 'update', recordId: 'lead-1', version: 1, title: 'Updated deal',
    })
    expect(updated.values).toEqual({ 'lead-status': 'Open' })
    await expect(invokeGadget(env, member, created.id, {
      bindingId: 'companies', operation: 'update', recordId: 'company-1', version: 1, title: 'Changed',
    })).rejects.toThrow('does not allow that operation')
    expect(sqlite.prepare("SELECT COUNT(*) as count FROM database_items WHERE database_id = 'companies'").get()).toEqual({ count: 1 })
    sqlite.close()
  })

  it('keeps draft identity and Role access private until the next publish', async () => {
    const sqlite = fixture()
    const env = { DB: d1(sqlite) } as never
    const manager = actor()
    const member = actor({ roleId: 'member-role', roleName: 'Member', perms: Permission.useGadgets, isOwner: false })
    const reviewer = actor({ roleId: 'reviewer-role', roleName: 'Reviewer', perms: Permission.useGadgets, isOwner: false })
    const created = await createGadget(env, manager, {
      name: 'Published sales desk',
      description: 'Published description',
      spec,
      roleIds: ['member-role'],
    })
    const published = await publishGadget(env, manager, created.id, created.draftRevision)

    const draft = await updateGadget(env, manager, created.id, {
      revision: published.draftRevision,
      name: 'Private draft name',
      description: 'Private draft description',
      roleIds: ['reviewer-role'],
    })

    expect((await listGadgets(env, member)).gadgets[0]).toMatchObject({
      name: 'Published sales desk',
      description: 'Published description',
      publishedVersion: 1,
    })
    expect((await openGadget(env, member, created.id)).gadget).toMatchObject({
      name: 'Published sales desk',
      description: 'Published description',
      version: 1,
    })
    expect((await listGadgets(env, reviewer)).gadgets).toEqual([])
    await expect(openGadget(env, reviewer, created.id)).rejects.toThrow('App not found')

    await publishGadget(env, manager, created.id, draft.draftRevision)
    expect((await listGadgets(env, member)).gadgets).toEqual([])
    await expect(openGadget(env, member, created.id)).rejects.toThrow('App not found')
    expect((await listGadgets(env, reviewer)).gadgets[0]).toMatchObject({
      name: 'Private draft name',
      description: 'Private draft description',
      publishedVersion: 2,
    })
    expect((await openGadget(env, reviewer, created.id)).gadget).toMatchObject({
      name: 'Private draft name',
      description: 'Private draft description',
      version: 2,
    })
    sqlite.close()
  })

  it('cannot update a Record outside a bound filtered View', async () => {
    const sqlite = fixture()
    sqlite.exec(`
      INSERT INTO database_views (id, database_id, name, config_json, created_by) VALUES
        ('open-leads', 'leads', 'Open leads', '{"visibleFieldIds":null,"filters":[{"fieldId":"lead-status","operator":"equals","value":"Open"}],"sorts":[],"groupFieldId":null,"dateFieldId":null}', 'owner');
      INSERT INTO database_items (id, database_id, title, select_1, created_by) VALUES
        ('lead-won', 'leads', 'Closed deal', 'Won', 'owner');
    `)
    const env = { DB: d1(sqlite) } as never
    const filteredSpec: GadgetSpec = {
      schemaVersion: 1,
      bindings: [{
        id: 'open-leads',
        label: 'Leads / Open leads',
        source: { type: 'database_view', databaseId: 'leads', viewId: 'open-leads' },
        fieldIds: ['lead-status'],
        operations: ['read', 'update'],
      }],
      sections: [{ id: 'pipeline', bindingId: 'open-leads', title: 'Open leads', presentation: 'table' }],
    }
    const created = await createGadget(env, actor(), { name: 'Open pipeline', spec: filteredSpec, roleIds: ['member-role'] })
    await publishGadget(env, actor(), created.id, created.draftRevision)
    const member = actor({ roleId: 'member-role', perms: Permission.useGadgets, isOwner: false })

    await expect(invokeGadget(env, member, created.id, {
      bindingId: 'open-leads', operation: 'update', recordId: 'lead-won', version: 1, title: 'Not allowed',
    })).rejects.toThrow('does not belong to this App Binding')
    expect(sqlite.prepare("SELECT title FROM database_items WHERE id = 'lead-won'").get()).toEqual({ title: 'Closed deal' })
    sqlite.close()
  })
})
