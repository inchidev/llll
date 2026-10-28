import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { requireMemberForUser } from '../../server/utils/channel-access'
import { loadInbox } from '../../server/utils/inbox-service'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'

const serverId = '00000000-0000-4000-8000-000000000001'
const me = 'aaaaaaaa-0000-4000-8000-000000000001'
const other = 'aaaaaaaa-0000-4000-8000-000000000002'
const agent = 'aaaaaaaa-0000-4000-8000-000000000003'
const user = (id: string) => ({ id, kind: 'human' as const, displayName: id, avatarR2Key: null })
let sqlite: DatabaseSync
let env: L4Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  // Read-only fixtures: sessions, workspaces and environments are irrelevant to what the Inbox shows.
  sqlite.exec('PRAGMA foreign_keys = OFF')
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const recent = new Date(Date.now() - 3_600_000).toISOString()
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages | Permission.readTasks | Permission.useAgents});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('${other}','Ana','active','member','2026-01-01'),('${me}','Me','active','member','2026-01-01');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('${agent}','agent','Jev','active','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','${other}');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','general','text','server'),('secret','secret','text','private');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('m01','chat','${other}','read already <@${me}>','2026-01-01'),
      ('m02','chat','${other}','<@${me}> can you review?','2026-01-02'),
      ('m03','secret','${other}','<@${me}> private','2026-01-03'),
      ('m04','chat','${me}','note to self <@${me}>','2026-01-04');
    INSERT INTO messages(id,channel_id,author_id,content,deleted_at,created_at) VALUES('m05','chat','${other}','<@${me}> removed','2026-01-05','2026-01-05');
    INSERT INTO message_mentions(message_id,user_id) VALUES('m01','${me}'),('m02','${me}'),('m03','${me}'),('m04','${me}'),('m05','${me}');
    INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES('chat','${me}','m01','2026-01-01');
    INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at) VALUES
      ('run-mine','s','${agent}','chat','${me}','k1','running','p','m','i','{}','${future}','${recent}','${recent}'),
      ('run-done','s','${agent}','chat','${me}','k2','completed','p','m','i','{}','${future}','${recent}','${recent}'),
      ('run-old','s','${agent}','chat','${me}','k3','completed','p','m','i','{}','${future}','${old}','${old}'),
      ('run-theirs','s','${agent}','chat','${other}','k4','running','p','m','i','{}','${future}','${recent}','${recent}');
    INSERT INTO agent_code_proposals(run_id,environment_id,input_hash,branch,pull_number,created_at,updated_at) VALUES('run-done','env','h','l4-agent/run-done',42,'${recent}','${recent}');
    INSERT INTO factory_actions(id,workspace_id,run_id,call_id,digest,request_json,policy_json,status,expires_at,created_at) VALUES
      ('act-mine','w1','run-mine','c1','d','{"operation":"exec"}','{}','pending','${future}','${recent}'),
      ('act-expired','w2','run-mine','c2','d','{"operation":"write"}','{}','pending','${recent}','${recent}'),
      ('act-theirs','w3','run-theirs','c3','d','{"operation":"exec"}','{}','pending','${future}','${recent}');
    INSERT INTO task_boards(id,name,created_by) VALUES('board','Roadmap','${other}');
    INSERT INTO tasks(id,board_id,title,status,assignee_id,created_by) VALUES
      ('t-assigned','board','Fix login','ready','${me}','${other}'),
      ('t-done','board','Old work','done','${me}','${other}'),
      ('t-review','board','Agent PR','review','${agent}','${me}'),
      ('t-theirs','board','Not mine','review','${agent}','${other}');`)
  env = { DB: d1(sqlite) } as unknown as L4Env
})
afterEach(() => sqlite.close())

describe('Inbox', () => {
  it('lists only unread mentions by others in conversations the member can still open', async () => {
    const inbox = await loadInbox(env, await requireMemberForUser(env, user(me), serverId))
    expect(inbox.mentions).toEqual([expect.objectContaining({ messageId: 'm02', path: '/channels/chat', conversation: 'general', excerpt: '@Me can you review?' })])
    expect(inbox.mentions[0]!.author).toMatchObject({ id: other, displayName: 'Ana' })
  })

  it('shows this member’s live approvals and recent Runs, never another member’s', async () => {
    const inbox = await loadInbox(env, await requireMemberForUser(env, user(me), serverId))
    expect(inbox.approvals).toEqual([expect.objectContaining({ id: 'act-mine', kind: 'workspace', runId: 'run-mine', agentName: 'Jev', operation: 'exec' })])
    expect(inbox.runs.map(run => run.id).sort()).toEqual(['run-done', 'run-mine'])
    expect(inbox.runs.find(run => run.id === 'run-done')?.pullNumber).toBe(42)
  })

  it('separates Tasks assigned to the member from their Tasks waiting for review', async () => {
    const inbox = await loadInbox(env, await requireMemberForUser(env, user(me), serverId))
    expect(inbox.assigned.map(task => task.id)).toEqual(['t-assigned'])
    expect(inbox.review.map(task => task.id)).toEqual(['t-review'])
    expect(inbox.assigned[0]).toMatchObject({ title: 'Fix login', boardName: 'Roadmap' })
  })

  it('omits Tasks when the Role cannot read them', async () => {
    sqlite.exec(`UPDATE roles SET permissions_bitmask=${Permission.sendMessages} WHERE id='member'`)
    const inbox = await loadInbox(env, await requireMemberForUser(env, user(me), serverId))
    expect(inbox.assigned).toEqual([])
    expect(inbox.review).toEqual([])
  })
})
