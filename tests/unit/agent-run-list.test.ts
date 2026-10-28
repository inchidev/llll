import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import { requireMemberForUser } from '../../server/utils/channel-access'
import { listOwnRuns, RUN_LIST_PAGE_SIZE } from '../../server/utils/agent-run-list'
import type { L4Env } from '../../workers/env'

const serverId = '00000000-0000-4000-8000-000000000001'
let db: DatabaseSync, env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system) VALUES('member-role','member','Member',${Permission.sendMessages | Permission.useAgents},'{}',1);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner','human','Owner','active','member-role','2026-10-25'),
      ('me','human','Me','active','member-role','2026-10-25'),
      ('someone','human','Someone','active','member-role','2026-10-25'),
      ('pi','agent','Pi','active','member-role','2026-10-25'),
      ('reviewer','agent','Reviewer','active','member-role','2026-10-25');
    INSERT INTO agents(user_id,harness,model,instructions,status,created_by) VALUES('pi','pi','m','','active','owner'),('reviewer','pi','m','','active','owner');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Fixture','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('general','general','text','server'),('secret','secret','text','private');
    INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES('s1','pi','general','t','t'),('s2','reviewer','general','t','t'),('s3','pi','secret','t','t');
    INSERT INTO task_boards(id,name,created_by) VALUES('board','Work','owner');
    INSERT INTO tasks(id,board_id,title,created_by) VALUES('task','board','Ship it','owner');`)
  const run = db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,task_id,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'m','i','{}','d',?,?)`)
  run.run('mine-done', 's1', 'pi', 'general', 'me', 'task', 'k1', 'completed', 'Finish the task', '2026-10-25T01:00:00Z', '2026-10-25T01:00:00Z')
  run.run('mine-failed', 's2', 'reviewer', 'general', 'me', null, 'k2', 'failed', 'Review', '2026-10-25T02:00:00Z', '2026-10-25T02:00:00Z')
  run.run('mine-private', 's3', 'pi', 'secret', 'me', null, 'k3', 'completed', 'Secret work', '2026-10-25T03:00:00Z', '2026-10-25T03:00:00Z')
  run.run('theirs', 's1', 'pi', 'general', 'someone', null, 'k4', 'running', 'Not mine', '2026-10-25T04:00:00Z', '2026-10-25T04:00:00Z')
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())
const me = () => requireMemberForUser(env, { id: 'me', kind: 'human', displayName: 'Me', avatarR2Key: null }, serverId)

it('lists only my runs in conversations I can still read, newest first, with agent and task', async () => {
  const page = await listOwnRuns(env, await me())
  expect(page.runs.map(run => run.id)).toEqual(['mine-failed', 'mine-done'])
  expect(page.runs[1]).toMatchObject({ agentName: 'Pi', taskNumber: 1001, prompt: 'Finish the task', status: 'completed' })
  expect(page.agents.map(agent => agent.displayName)).toEqual(['Pi', 'Reviewer'])
  expect(page.nextCursor).toBeNull()
})

it('shows a private conversation run again once I am a member', async () => {
  db.exec("INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('secret','me','2026-10-25')")
  expect((await listOwnRuns(env, await me())).runs.map(run => run.id)).toEqual(['mine-private', 'mine-failed', 'mine-done'])
})

it('filters by status and agent', async () => {
  expect((await listOwnRuns(env, await me(), { status: 'failed' })).runs.map(run => run.id)).toEqual(['mine-failed'])
  expect((await listOwnRuns(env, await me(), { agentId: 'pi' })).runs.map(run => run.id)).toEqual(['mine-done'])
  expect((await listOwnRuns(env, await me(), { agentId: 'pi', status: 'failed' })).runs).toEqual([])
})

it('pages with a stable cursor', async () => {
  const insert = db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
    VALUES(?,'s1','pi','general','me',?,'completed','p','m','i','{}','d',?,?)`)
  for (let i = 0; i < RUN_LIST_PAGE_SIZE; i++) insert.run(`bulk-${String(i).padStart(2, '0')}`, `bulk-${i}`, '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')
  const first = await listOwnRuns(env, await me())
  // The private run fills a slot on the first page and is then hidden, so that page is one short.
  expect(first.runs).toHaveLength(RUN_LIST_PAGE_SIZE - 1)
  const second = await listOwnRuns(env, await me(), { cursor: first.nextCursor })
  expect(new Set([...first.runs, ...second.runs].map(run => run.id)).size).toBe(RUN_LIST_PAGE_SIZE + 2)
  expect(second.nextCursor).toBeNull()
})
