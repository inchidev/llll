import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { reserveRunInference } from '../../server/utils/agent-inference-budget'
import type { AgentRun } from '../../shared/agent-execution'

let db: DatabaseSync
const run = { id: 'run', agentId: 'agent', mandateJson: JSON.stringify({ maxModelCalls: 20, maxTokens: 64000 }) } as AgentRun
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE agent_runs(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,model_calls INTEGER,total_tokens INTEGER,created_at TEXT,last_error TEXT,mandate_json TEXT DEFAULT '{}')`)
  db.prepare("INSERT INTO agent_runs(id,agent_id,status,model_calls,total_tokens,created_at,last_error) VALUES ('run','agent','running',0,0,?,NULL)").run(new Date().toISOString())
})
afterEach(() => db.close())
const reserve = (amount = 1000) => reserveRunInference({ DB: d1(db) }, run, amount)
it.each([
  ['model_calls=20', 'run_model_call_limit', 'model-call limit'],
  ['total_tokens=63500', 'run_token_budget', 'reserved response allowance'],
] as const)('rejects %s without spending counters or confusing the reason', async (setup, code, message) => {
  db.exec('UPDATE agent_runs SET ' + setup)
  const before = db.prepare('SELECT model_calls,total_tokens FROM agent_runs').get()
  expect(await reserve()).toMatchObject({ ok: false, status: 400, code, message: expect.stringContaining(message) })
  expect(db.prepare('SELECT model_calls,total_tokens FROM agent_runs').get()).toEqual(before)
  expect(db.prepare('SELECT last_error FROM agent_runs').get()?.last_error).toContain(message)
})
it('distinguishes rolling agent usage from this Run and includes failed attempts', async () => {
  db.prepare("INSERT INTO agent_runs(id,agent_id,status,model_calls,total_tokens,created_at,last_error) VALUES ('prior','agent','failed',3,249500,?,NULL)").run(new Date().toISOString())
  expect(await reserve()).toMatchObject({ ok: false, status: 400, code: 'agent_daily_token_budget', message: expect.stringContaining('rolling 24-hour') })
  expect(db.prepare("SELECT model_calls,total_tokens FROM agent_runs WHERE id='run'").get()).toEqual({ model_calls: 0, total_tokens: 0 })
})
it('ignores another agent and expired usage, and admits exact budget boundaries', async () => {
  db.prepare("INSERT INTO agent_runs(id,agent_id,status,model_calls,total_tokens,created_at,last_error) VALUES ('other','foreign','completed',3,999999,?,NULL)").run(new Date().toISOString())
  db.prepare("INSERT INTO agent_runs(id,agent_id,status,model_calls,total_tokens,created_at,last_error) VALUES ('old','agent','completed',3,999999,?,NULL)").run(new Date(Date.now() - 2 * 86400000).toISOString())
  db.exec("UPDATE agent_runs SET model_calls=19,total_tokens=63000 WHERE id='run'")
  expect(await reserve()).toEqual({ ok: true, callNumber: 20 })
  expect(db.prepare("SELECT model_calls,total_tokens FROM agent_runs WHERE id='run'").get()).toEqual({ model_calls: 20, total_tokens: 64000 })
})
it('does not over-admit concurrent reservations', async () => {
  db.exec("UPDATE agent_runs SET total_tokens=62500 WHERE id='run'")
  const outcomes = await Promise.all([reserve(), reserve()])
  expect(outcomes.filter(result => result.ok)).toHaveLength(1)
  expect(outcomes.find(result => !result.ok)).toMatchObject({ code: 'run_token_budget' })
  expect(db.prepare("SELECT model_calls,total_tokens FROM agent_runs WHERE id='run'").get()).toEqual({ model_calls: 1, total_tokens: 63500 })
})
it('does not replace the terminal reason of an inactive Run', async () => {
  db.exec("UPDATE agent_runs SET status='cancelled',last_error='Cancelled by sender'")
  expect(await reserve()).toMatchObject({ ok: false, status: 409, code: 'run_inactive' })
  expect(db.prepare('SELECT last_error FROM agent_runs').get()?.last_error).toBe('Cancelled by sender')
})
