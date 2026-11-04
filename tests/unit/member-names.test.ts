import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { assertAgentNameAvailable, assertHumanNameAvailable, memberNameKey } from '../../server/utils/member-names'
import { memberRemovalPath } from '../../app/utils/member-removal'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

it.each([
  ['case and compatibility forms', 'ALICE'], ['fullwidth', 'Ａｌｉｃｅ'], ['Cyrillic а', 'Аlice'], ['Cyrillic letters inside', 'Аliсе'],
  ['Greek capitals', 'ΑΙice'], ['zero-width', 'Al​ice'], ['bidi override', '‮Alice‬'], ['joiner', 'A⁠lice'], ['capital I for l', 'AIice'],
  ['digit for l', 'A1ice'], ['dotless i', 'Alıce'], ['dotted capital I', 'ALİCE'], ['extra spaces', ' Alice  '],
])('reads %s as the same name', (_label, name) => {
  expect(memberNameKey(name)).toBe(memberNameKey('Alice'))
})

it('folds what lower() does not, and leaves different names different', () => {
  expect(memberNameKey('STRASSE')).toBe(memberNameKey('straße'))
  expect(memberNameKey('ΣΑΣ')).toBe(memberNameKey('σας'))
  expect(memberNameKey('Bob')).not.toBe(memberNameKey('Alice'))
  expect(memberNameKey('Ann Lee')).not.toBe(memberNameKey('AnnLee'))
})

let db: DatabaseSync, env: L4Env
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('role','role','Role',0);
    INSERT INTO users(id,kind,display_name,nickname,status,role_id,joined_at) VALUES('person','human','Alice','Ace','active','role','2026-11-04'),('bot','agent','Robo',NULL,'active','role','2026-11-04'),('gone','agent','Zed',NULL,'removed',NULL,NULL),('other','human','Sam',NULL,'active','role','2026-11-04')`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

it('refuses an Agent a lookalike of anyone\'s name or nickname, but not its own or a removed one', async () => {
  await expect(assertAgentNameAvailable(env, 'Аlice')).rejects.toMatchObject({ statusCode: 409 })
  await expect(assertAgentNameAvailable(env, 'A​ce')).rejects.toMatchObject({ statusCode: 409 })
  await expect(assertAgentNameAvailable(env, 'Rοbο', 'bot')).resolves.toBeUndefined()
  await expect(assertAgentNameAvailable(env, 'Zed')).resolves.toBeUndefined()
})

it('refuses a person a lookalike of an Agent\'s name, and lets people share theirs', async () => {
  await expect(assertHumanNameAvailable(env, 'Rοbο', 'other')).rejects.toMatchObject({ statusCode: 409 })
  await expect(assertHumanNameAvailable(env, 'Alice', 'other')).resolves.toBeUndefined()
})

it('refuses a name with nothing visible in it', async () => {
  await expect(assertAgentNameAvailable(env, '​⁠')).rejects.toMatchObject({ statusCode: 400 })
  await expect(assertHumanNameAvailable(env, '‮', 'other')).rejects.toMatchObject({ statusCode: 400 })
})

it('sends Agents to the Agent delete route and everyone else to the Member route', () => {
  expect(memberRemovalPath('s', { id: 'a', kind: 'agent' })).toBe('/api/servers/s/agents/a')
  expect(memberRemovalPath('s', { id: 'h', kind: 'human' })).toBe('/api/servers/s/members/h')
})
