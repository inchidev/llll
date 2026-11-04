import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { listSpacesAdmin, refreshSpaceStats } from '../../server/utils/space-admin'
import { assertHumanNameAvailable } from '../../server/utils/member-names'
import { loadSpaceBoundary } from '../../server/utils/space-access'
import { consumeSpaceQuota, monthlyPeriod } from '../../server/utils/space-quota'
import { setSpaceLimits, setSpaceSuspended } from '../../server/utils/space-service'
import type { ServerMembership } from '../../server/utils/channel-access'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

const OWNER = 'owner', SERVER = '00000000-0000-4000-8000-000000000001'
const owner = { user: { id: OWNER, kind: 'human' }, isOwner: true, serverId: SERVER, authorization: { credential: { kind: 'session' } } } as unknown as ServerMembership
const member = { user: { id: 'person-1', kind: 'human' }, isOwner: false, serverId: SERVER, authorization: { credential: { kind: 'session' } } } as unknown as ServerMembership
const spaceId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`

function fixture(count: number) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES ('role-owner','owner','Owner',${ALL_PERMISSIONS},'{}'), ('role-member','member','Member',48,'{}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES ('${OWNER}','human','Operator','active','role-owner','2026-01-01T00:00:00.000Z');
    INSERT INTO server(id,name,owner_id) VALUES ('${SERVER}','Cloud','${OWNER}');`)
  for (let index = 1; index <= count; index++) {
    const id = spaceId(index)
    sqlite.exec(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES ('person-${index}','human','Person ${index}','active','role-member','2026-01-01T00:00:00.000Z');
      DELETE FROM space_members WHERE user_id = 'person-${index}';
      INSERT INTO auth_users(id,name,email,email_verified,username,created_at,updated_at) VALUES ('person-${index}','Person ${index}','person${index}@example.com',1,'person-${index}',0,0);
      INSERT INTO spaces(id,name,created_by,created_at,updated_at) VALUES ('${id}','Space ${String(index).padStart(2, '0')}','person-${index}','2026-01-${String((index % 27) + 1).padStart(2, '0')}T00:00:00.000Z','x');
      INSERT INTO space_members(space_id,user_id,role) VALUES ('${id}','person-${index}','admin');
      INSERT INTO task_boards(id,space_id,name,created_by,created_at,updated_at) VALUES ('board-${index}','${id}','Tasks','person-${index}','x','x');`)
    // Each Space has as many Tasks as its number, so the order is known.
    for (let task = 0; task < index; task++) sqlite.exec(`INSERT INTO tasks(id,board_id,title,created_by,created_at,updated_at) VALUES ('t-${index}-${task}','board-${index}','SECRET TITLE','person-${index}','x','2026-02-01T00:00:00.000Z');`)
  }
  return { sqlite, env: { DB: d1(sqlite) } as unknown as L4Env }
}
const list = (env: L4Env, query: Record<string, unknown> = {}, who = owner) => listSpacesAdmin(env, who, query, () => undefined)

describe('the Owner’s table of Spaces', () => {
  it('refuses everyone but the Owner in a session', async () => {
    const { env } = fixture(1)
    await expect(list(env, {}, member)).rejects.toThrow()
    const token = { ...owner, authorization: { credential: { kind: 'mcp' } } } as unknown as ServerMembership
    await expect(list(env, {}, token)).rejects.toThrow()
    await expect(setSpaceSuspended(env, member, spaceId(1), true)).rejects.toThrow()
    await expect(setSpaceLimits(env, member, spaceId(1), { reset: true })).rejects.toThrow()
  })

  it('sorts across pages on the Server, with a stable order', async () => {
    const { env } = fixture(30)
    const first = await list(env, { sort: 'tasks', dir: 'desc', pageSize: 10 })
    const second = await list(env, { sort: 'tasks', dir: 'desc', pageSize: 10, page: 2 })
    // The default Space has no Tasks and sorts last.
    expect(first.total).toBe(31)
    expect(first.spaces.map(space => space.tasks)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21])
    expect(second.spaces.map(space => space.tasks)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11])
    const named = await list(env, { sort: 'name', dir: 'asc', pageSize: 3 })
    expect(named.spaces.map(space => space.name)).toEqual(['General', 'Space 01', 'Space 02'])
    for (const sort of ['creator', 'people', 'projects', 'recordings', 'storage', 'voice', 'messages', 'created', 'activity']) {
      expect((await list(env, { sort, pageSize: 2 })).spaces, sort).toHaveLength(2)
    }
  })

  it('refuses a column it does not know, which is what keeps the sort out of the SQL', async () => {
    const { env } = fixture(1)
    await expect(list(env, { sort: 's.name; DROP TABLE spaces' })).rejects.toThrow()
  })

  it('searches by name, creator and email, and takes wildcards literally', async () => {
    const { env } = fixture(12)
    expect((await list(env, { q: 'Space 07' })).spaces.map(space => space.id)).toEqual([spaceId(7)])
    expect((await list(env, { q: 'Person 11' })).spaces.map(space => space.id)).toEqual([spaceId(11)])
    expect((await list(env, { q: 'person3@' })).spaces.map(space => space.id)).toEqual([spaceId(3)])
    expect((await list(env, { q: '%' })).total).toBe(0)
  })

  it('filters by what is near or at a limit, across storage and voice', async () => {
    const { sqlite, env } = fixture(4)
    sqlite.exec(`UPDATE spaces SET storage_limit_bytes = 100 WHERE id IN ('${spaceId(1)}','${spaceId(2)}');
      INSERT INTO task_attachments(id,task_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES ('a1','t-1-0','person-1','k1','secret-name.png','image/png',85,'x'),('a2','t-2-0','person-2','k2','f','image/png',100,'x');
      UPDATE spaces SET monthly_voice_limit = 2 WHERE id = '${spaceId(3)}';`)
    await consumeSpaceQuota(env, spaceId(3), 'voice', 'voice')
    await consumeSpaceQuota(env, spaceId(3), 'voice', 'voice')
    await expect(consumeSpaceQuota(env, spaceId(3), 'voice', 'voice')).rejects.toThrow()
    await refreshSpaceStats(env)
    const ids = async (limit: string) => (await list(env, { limit })).spaces.map(space => space.id).sort()
    expect(await ids('near')).toEqual([spaceId(1), spaceId(2), spaceId(3)])
    expect(await ids('over')).toEqual([spaceId(2), spaceId(3)])
    const row = (await list(env, { q: 'Space 03' })).spaces[0]!
    expect(row).toMatchObject({ voiceMinutes: 2, quotas: { monthlyVoiceLimit: 2 } })
    // Nothing of what a Space holds reaches the table.
    const whole = JSON.stringify(await list(env, { pageSize: 100 }))
    expect(whole).not.toContain('SECRET TITLE')
    expect(whole).not.toContain('secret-name')
  })

  it('filters inactive and suspended Spaces', async () => {
    const { sqlite, env } = fixture(2)
    await refreshSpaceStats(env)
    sqlite.exec(`UPDATE space_stats SET last_activity_at = '${new Date().toISOString()}' WHERE space_id = '${spaceId(1)}'`)
    const inactive = (await list(env, { state: 'inactive' })).spaces.map(space => space.id)
    expect(inactive).toContain(spaceId(2))
    expect(inactive).not.toContain(spaceId(1))
    await setSpaceSuspended(env, owner, spaceId(2), true)
    expect((await list(env, { state: 'suspended' })).spaces.map(space => space.id)).toEqual([spaceId(2)])
  })

  it('takes a single statement of joins for any number of Spaces, and refreshes only when stale', async () => {
    const { sqlite, env } = fixture(3)
    const first = await list(env)
    expect(first.refreshedAt).toBeTruthy()
    sqlite.exec("INSERT INTO tasks(id,board_id,title,created_by,created_at,updated_at) VALUES ('new','board-1','T','person-1','x','x')")
    let scheduled = 0
    expect((await listSpacesAdmin(env, owner, { q: 'Space 01' }, () => { scheduled++ })).spaces[0]!.tasks).toBe(1)
    expect(scheduled).toBe(0)
    sqlite.exec("UPDATE space_stats SET refreshed_at = '2020-01-01T00:00:00.000Z'")
    await listSpacesAdmin(env, owner, { q: 'Space 01' }, () => { scheduled++ })
    expect(scheduled).toBe(1)
    await refreshSpaceStats(env)
    expect((await list(env, { q: 'Space 01' })).spaces[0]!.tasks).toBe(2)
  })
})

describe('managing one Space', () => {
  it('suspends without losing anything, keeps the Owner’s reach, and is on the record', async () => {
    const { sqlite, env } = fixture(2)
    const id = spaceId(1)
    sqlite.exec(`INSERT INTO space_members(space_id,user_id,role) VALUES ('${id}','${OWNER}','admin')`)
    expect((await loadSpaceBoundary(env, 'person-1')).ids).toEqual([id])
    await setSpaceSuspended(env, owner, id, true)
    const out = await loadSpaceBoundary(env, 'person-1')
    expect(out.ids).toEqual([])
    expect(out.denied.boards?.has('board-1')).toBe(true)
    expect((await loadSpaceBoundary(env, OWNER)).ids).toContain(id)
    expect((await loadSpaceBoundary(env, 'person-2')).ids).toEqual([spaceId(2)])
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?').get('board-1') as { n: number }).n).toBe(1)
    await setSpaceSuspended(env, owner, id, false)
    expect((await loadSpaceBoundary(env, 'person-1')).ids).toEqual([id])
    const actions = sqlite.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at, id").all(id) as Array<{ action: string }>
    expect(actions.map(row => row.action)).toEqual(['space.suspend', 'space.resume'])
  })

  it('will not suspend the default Space, which would be the whole Server', async () => {
    const { env } = fixture(1)
    await expect(setSpaceSuspended(env, owner, DEFAULT_SPACE_ID, true)).rejects.toThrow(/default/u)
  })

  it('sets limits, voice among them, and returns to no limit', async () => {
    const { sqlite, env } = fixture(1)
    const space = await setSpaceLimits(env, owner, spaceId(1), { monthlyVoiceLimit: 5, storageLimitBytes: 100 })
    expect(space.quotas).toMatchObject({ monthlyVoiceLimit: 5, storageLimitBytes: 100 })
    const reset = await setSpaceLimits(env, owner, spaceId(1), { reset: true })
    expect(reset.quotas).toMatchObject({ monthlyVoiceLimit: null, storageLimitBytes: null })
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'space.limits'").get() as { n: number }).n).toBe(2)
  })

  it('counts voice for the month it was spoken in', async () => {
    const { sqlite, env } = fixture(1)
    await consumeSpaceQuota(env, spaceId(1), 'voice', 'voice')
    sqlite.exec(`INSERT INTO space_usage(space_id,metric,period,count) VALUES ('${spaceId(1)}','voice','2000-01',9)`)
    expect((await list(env, { q: 'Space 01' })).spaces[0]!.voiceMinutes).toBe(1)
    expect(monthlyPeriod()).toMatch(/^\d{4}-\d{2}$/u)
  })
})

describe('across Spaces', () => {
  it('counts Task numbers per Space', () => {
    const { sqlite } = fixture(0)
    sqlite.exec(`INSERT INTO task_boards(id,space_id,name,created_by,created_at,updated_at) VALUES('b','${DEFAULT_SPACE_ID}','B','${OWNER}','x','x');
      INSERT INTO tasks(id,board_id,title,created_by,created_at,updated_at) VALUES('t1','b','One','${OWNER}','x','x'),('t2','b','Two','${OWNER}','x','x');`)
    expect(sqlite.prepare('SELECT number, space_id AS spaceId FROM task_numbers ORDER BY number').all()).toEqual([{ number: 1, spaceId: DEFAULT_SPACE_ID }, { number: 2, spaceId: DEFAULT_SPACE_ID }])
    expect(() => sqlite.exec("UPDATE task_numbers SET number = 1 WHERE task_id = 't2'")).toThrow(/UNIQUE/u)
  })

  it('refuses a person the name of an Agent in any Space', async () => {
    const { sqlite, env } = fixture(2)
    sqlite.exec(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES ('robo','agent','Robo','active','role-member','2026-01-01T00:00:00.000Z');
      DELETE FROM space_members WHERE user_id='robo'; INSERT INTO space_members(space_id,user_id) VALUES ('${spaceId(2)}','robo');`)
    await expect(assertHumanNameAvailable(env, 'Robo', 'person-1')).rejects.toThrow()
  })
})
