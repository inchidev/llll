import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { admitQueuedAgentRun } from '../../workers/agent-run-admission'
import type { L4Env } from '../../workers/env'
let db: DatabaseSync, env: L4Env
const run = (id: string, channelId: string) => ({ id, channelId, agentId: 'pi', sessionId: `session-${id}` })
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE channels(id TEXT PRIMARY KEY,parent_id TEXT);
    CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,active_run_id TEXT);
    CREATE TABLE agent_runs(id TEXT PRIMARY KEY,agent_id TEXT,channel_id TEXT,status TEXT,updated_at TEXT,deadline TEXT);
    INSERT INTO channels VALUES('dm',NULL),('thread-a','dm'),('thread-b','dm'),('other-dm',NULL);
    INSERT INTO agent_sessions VALUES('session-01',NULL),('session-02',NULL),('session-03',NULL);`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())
it('queues different threads of a DM in send order and admits another conversation independently', async () => {
  db.exec("INSERT INTO agent_runs VALUES('01','pi','thread-a','queued','', '2999-01-01'),('02','pi','thread-b','queued','', '2999-01-01'),('03','pi','other-dm','queued','', '2999-01-01')")
  expect(await admitQueuedAgentRun(env, run('02', 'thread-b'))).toBe(false)
  expect(await admitQueuedAgentRun(env, run('01', 'thread-a'))).toBe(true)
  expect(await admitQueuedAgentRun(env, run('02', 'thread-b'))).toBe(false)
  expect(await admitQueuedAgentRun(env, run('03', 'other-dm'))).toBe(true)
  db.exec("UPDATE agent_runs SET status='completed' WHERE id='01'")
  expect(await admitQueuedAgentRun(env, run('02', 'thread-b'))).toBe(true)
})
it('cannot start a cancelled queued message after Steer claimed it', async () => {
  db.exec("INSERT INTO agent_runs VALUES('01','pi','thread-a','cancelled','', '2999-01-01')")
  expect(await admitQueuedAgentRun(env, run('01', 'thread-a'))).toBe(false)
})
it('recovers a terminal session claim immediately without waiting for executor cleanup', async () => {
  db.exec("INSERT INTO agent_runs VALUES('old','pi','thread-a','failed','', '2999-01-01'),('01','pi','thread-a','queued','', '2999-01-01'); UPDATE agent_sessions SET active_run_id='old' WHERE id='session-01'")
  expect(await admitQueuedAgentRun(env, run('01', 'thread-a'))).toBe(true)
  expect(db.prepare("SELECT active_run_id FROM agent_sessions WHERE id='session-01'").get()?.active_run_id).toBe('01')
})
