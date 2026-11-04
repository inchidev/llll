import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { agentAuditPage } from '../../server/utils/agent-audit'
import type { L4Env } from '../../workers/env'
let db: DatabaseSync, env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO users(id,kind,display_name) VALUES('human','human','Member'),('agent','agent','Pi');
    INSERT INTO agents(user_id,created_by,harness) VALUES('agent','human','pi');
    INSERT INTO audit_log(id,actor_id,action,target_type,target_id,created_at) VALUES
    ('01','human','member.update','user','human','2026-10-23'),
    ('02','human','agent.provider.update','server','server','2026-10-23'),
    ('03','agent','task.create','task','task-id','2026-10-23');
    INSERT INTO channels(id,name,type) VALUES('chat','Chat','text');
    INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES('session','agent','chat','2026-10-23','2026-10-23');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())
it('filters changes to agent administration and actions by agents', async () => {
  const result = await agentAuditPage(env, 'changes', '', 1)
  expect(result.total).toBe(2)
  expect(result.entries.map(e => e.id)).toEqual(['03', '02'])
  expect((await agentAuditPage(env, 'changes', 'provider', 1)).entries.map(e => e.id)).toEqual(['02'])
})
it('paginates Run metadata and usage without returning prompt or transcript fields', async () => {
  for (let i = 0; i < 23; i++) db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at) VALUES(?,'session','agent','chat','human',?,'completed','private prompt','fixture-model','private instructions','{}','2999-01-01','2026-10-23','2026-10-23')`).run(String(i).padStart(2,'0'), String(i))
  const result = await agentAuditPage(env, 'runs', 'Pi', 1)
  expect(result.total).toBe(23); expect(result.entries).toHaveLength(20)
  expect((await agentAuditPage(env, 'runs', '', 2)).entries).toHaveLength(3)
  expect(JSON.stringify(result)).not.toContain('private prompt')
  expect(JSON.stringify(result)).not.toContain('private instructions')
  expect(result.entries[0]).toMatchObject({ agentName: 'Pi', initiatorName: 'Member', modelCalls: 0, toolCalls: 0, totalTokens: 0 })
})
