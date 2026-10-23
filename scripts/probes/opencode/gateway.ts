import { DatabaseSync } from 'node:sqlite'
import { INIT_SQL } from '../../../server/utils/db'
import { d1 } from '../../../tests/helpers/sqlite-d1'
import { loadAuthorizationContext } from '../../../server/utils/authorization'
import { createAgentRun, runCapability } from '../../../server/utils/agent-run-service'
import { agentGateway } from '../../../server/utils/agent-gateway'
import { Permission } from '../../../shared/permissions'
import type { L4Env } from '../../../workers/env'

export function fixture(path: string) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(INIT_SQL)
  const serverId = '00000000-0000-4000-8000-000000000001'
  const agentId = '00000000-0000-4000-8000-000000000002'
  db.exec(`INSERT OR IGNORE INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT OR IGNORE INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES
      ('owner-role','owner','Owner',0,'{}'),('agent-role','custom:agent','Probe agent',${Permission.sendMessages | Permission.readTasks},'{"boards":["board-allowed"]}');
    INSERT OR IGNORE INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-user','human','Owner','active','owner-role','2026-10-23'),('${agentId}','agent','Probe agent','active','agent-role','2026-10-23');
    INSERT OR IGNORE INTO server(id,name,owner_id) VALUES('${serverId}','Isolated probe','owner-user');
    INSERT OR IGNORE INTO agents(user_id,created_by,harness,model) VALUES('${agentId}','owner-user','pi','');
    INSERT OR IGNORE INTO channels(id,name,type,visibility) VALUES('public-chat','Probe','text','server');
    INSERT OR IGNORE INTO task_boards(id,name,created_by) VALUES('board-allowed','Allowed board','owner-user'),('board-private','Private board','owner-user');`)
  const env = { DB: d1(db), AUTH_SECRET: 'isolated-opencode-probe-secret-32-characters', FILES: {}, AI: {}, SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) }, AGENT_RUNNER_URL: 'http://fixture-runner', AGENT_RUNNER_TOKEN: 'fixture-only', AGENT_RUN_DO: { getByName: () => ({ wake: async () => {} }) } } as unknown as L4Env
  return {
    db,
    async run(write = false) {
      db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.sendMessages | Permission.readTasks | (write ? Permission.writeTasks : 0), 'agent-role')
      const auth = await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } })
      const run = await createAgentRun(env, auth!, { agentId, channelId: 'public-chat', prompt: 'OpenCode acceptance', idempotencyKey: crypto.randomUUID() })
      db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
      return { runId: run.id, capability: await runCapability(env, run.id) }
    },
    tools(request: Request) { return agentGateway(request, env, request.headers.get('x-run-id')!, 'tools', () => {}) },
  }
}
