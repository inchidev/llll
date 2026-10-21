import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createTable } from '../../server/utils/table-service'
import { createRecord, readRecords } from '../../server/utils/record-service'

let db: DatabaseSync
let env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('data-role','custom:data','Researcher',${Permission.manageDatabases});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('agent-user','agent','Researcher','active','data-role','2026-10-21'),('owner-user','human','Owner','active','data-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Test','owner-user');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())
const actor = () => loadAuthorizationContext(env, { principalId: 'agent-user', credential: { kind: 'agent_runtime', id: 'research-run' }, delegatedBy: 'owner-user' })
describe('authorized research tables', () => {
  it('creates typed columns, stores source evidence, reads records and attributes the Agent', async () => {
    const auth = (await actor())!
    const table = await createTable(env, auth, { name: 'Market evidence', fields: [{ name: 'Source URL', type: 'text' }, { name: 'Price', type: 'number' }] })
    await createRecord(env, auth, table.id, { title: 'Example product', values: { [table.fields[0]!.id]: 'https://example.com/pricing', [table.fields[1]!.id]: 25 } })
    const page = await readRecords(env, auth, table.id)
    expect(JSON.stringify(page)).toContain('https://example.com/pricing')
    const audit = db.prepare("SELECT actor_id,meta_json FROM audit_log WHERE action='database.create'").get()!
    expect(audit.actor_id).toBe('agent-user')
    expect(JSON.parse(String(audit.meta_json))).toMatchObject({ principalKind: 'agent', delegatedBy: 'owner-user', credentialId: 'research-run' })
    expect(table.fields[0]).not.toHaveProperty('slot')
  })
  it('does not convert record editing or a resource selection into table administration', async () => {
    db.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='data-role'").run(Permission.writeData)
    await expect(createTable(env, (await actor())!, { name: 'Denied' })).rejects.toMatchObject({ statusCode: 403 })
    db.prepare("UPDATE roles SET permissions_bitmask=?,resource_access_json=? WHERE id='data-role'").run(Permission.manageDatabases, '{"databases":["existing-table"]}')
    await expect(createTable(env, (await actor())!, { name: 'Outside scope' })).rejects.toMatchObject({ statusCode: 403 })
    expect(db.prepare('SELECT count(*) as count FROM database_definitions').get()).toMatchObject({ count: 0 })
  })
  it('validates the entire schema before persisting a table', async () => {
    await expect(createTable(env, (await actor())!, { name: 'Invalid', fields: [{ name: 'Source', type: 'text' }, { name: 'source', type: 'text' }] })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.prepare('SELECT count(*) as count FROM database_definitions').get()).toMatchObject({ count: 0 })
  })
})
