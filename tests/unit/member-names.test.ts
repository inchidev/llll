import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({ body: {} as Record<string, unknown> }))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: 'person', kind: 'human', displayName: 'Ada', avatarR2Key: null }) }))

let db: DatabaseSync, env: L4Env
beforeEach(() => {
  for (const [name, value] of Object.entries({ defineEventHandler: (fn: unknown) => fn, readBody: async () => state.body, createError })) vi.stubGlobal(name, value)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system) VALUES('member-role','member','Member',0,'{}',1);
    INSERT INTO users(id,kind,display_name,status,role_id,nickname,joined_at) VALUES
    ('person','human','Ada','active','member-role',NULL,'2026-10-25'),
    ('other','human','Grace','active','member-role',NULL,'2026-10-25'),
    ('agent','agent','Codex','active','member-role','Helper','2026-10-25'),
    ('gone','agent','Retired','removed',NULL,NULL,NULL);
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');`)
  env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyMembersChanged: async () => {} }) } } as unknown as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

async function rename(displayName: string) {
  state.body = { displayName }
  const handler = (await import('../../server/api/me.patch')).default
  return handler({ context: { cloudflare: { env, context: { waitUntil: () => {} } } } } as never)
}

it.each(['Codex', ' codex ', 'HELPER'])('refuses a person taking an active agent name or nickname (%s)', async name => {
  await expect(rename(name)).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare("SELECT display_name FROM users WHERE id='person'").get()).toMatchObject({ display_name: 'Ada' })
})

it('still lets people share a name with another person or a deleted agent', async () => {
  await expect(rename('Grace')).resolves.toMatchObject({ user: { displayName: 'Grace' } })
  await expect(rename('Retired')).resolves.toMatchObject({ user: { displayName: 'Retired' } })
  expect(db.prepare("SELECT display_name FROM users WHERE id='person'").get()).toMatchObject({ display_name: 'Retired' })
})

it('rejects a name that is only whitespace', async () => {
  await expect(rename('   ')).rejects.toMatchObject({ statusCode: 400 })
})
