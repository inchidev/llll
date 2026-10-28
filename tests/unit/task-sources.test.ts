import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { requireMemberForUser } from '../../server/utils/channel-access'
import { createTask } from '../../server/utils/task-service'
import { requireTaskSourceMessage, taskDraftFromMessage, taskLinksForChannel, taskSourceFor } from '../../server/utils/task-sources'
import type { L4Env } from '../../workers/env'

const serverId = '00000000-0000-4000-8000-000000000001'
const tasksPerms = Permission.sendMessages | Permission.readTasks | Permission.writeTasks
let db: DatabaseSync, env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system) VALUES
      ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1),('member-role','custom:tasks','Tasks',${tasksPerms},'{}',0),('chat-role','custom:chat','Chat',${Permission.sendMessages},'{}',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner','human','Owner','active','owner-role','2026-10-25'),('00000000-0000-4000-8000-0000000000ad','human','Ada','active','member-role','2026-10-25'),('ada','human','Ada','active','member-role','2026-10-25'),
      ('bob','human','Bob','active','member-role','2026-10-25'),('chat','human','Chatty','active','chat-role','2026-10-25');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Fixture','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('general','general','text','server'),('secret','secret','text','private');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('secret','ada','2026-10-25');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('public-message','general','bob','## Fix the login page\nIt fails for <@00000000-0000-4000-8000-0000000000ad> on Safari.','2026-10-25T01:00:00Z'),
      ('secret-message','secret','ada','Rotate the private keys','2026-10-25T02:00:00Z'),
      ('gone-message','general','bob','Deleted','2026-10-25T03:00:00Z');
    UPDATE messages SET deleted_at='2026-10-25T04:00:00Z' WHERE id='gone-message';
    INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES('file','public-message','general','bob','k','trace.log','text/plain',10,'2026-10-25');
    INSERT INTO task_boards(id,name,created_by) VALUES('board','Work','owner');`)
  env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } } as unknown as L4Env
})
afterEach(() => db.close())
const member = (id: string) => requireMemberForUser(env, { id, kind: 'human', displayName: id, avatarR2Key: null }, serverId)
async function taskFrom(messageId: string, by = 'ada') {
  const actor = await member(by)
  const { message } = await requireTaskSourceMessage(env, actor, messageId)
  return createTask(env, actor.authorization, 'board', { title: 'From chat', description: '', priority: 'normal', dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [], source: { channelId: message.channelId, messageId: message.id } }, () => {})
}

it('prefills a task from a readable message with readable mentions and its attachments', async () => {
  const draft = await taskDraftFromMessage(env, await member('ada'), 'public-message')
  expect(draft).toMatchObject({ messageId: 'public-message', channelName: '#general', authorName: 'Bob', title: 'Fix the login page' })
  expect(draft.description).toContain('It fails for @Ada on Safari.')
  expect(draft.description).toContain('trace.log')
})

it('never copies a message from a conversation the member cannot read, nor a deleted one', async () => {
  await expect(taskDraftFromMessage(env, await member('bob'), 'secret-message')).rejects.toMatchObject({ statusCode: 404 })
  await expect(taskFrom('secret-message', 'bob')).rejects.toMatchObject({ statusCode: 404 })
  await expect(taskFrom('gone-message')).rejects.toMatchObject({ statusCode: 409 })
  await expect(taskFrom('missing-message')).rejects.toMatchObject({ statusCode: 404 })
})

it('records the source, audits it, and links both ways for readers of the conversation', async () => {
  const task = await taskFrom('public-message')
  expect(db.prepare('SELECT source_channel_id AS c, source_message_id AS m FROM tasks WHERE id=?').get(task.id)).toEqual({ c: 'general', m: 'public-message' })
  const audit = db.prepare("SELECT meta_json FROM audit_log WHERE action='task.create' AND target_id=?").get(task.id) as { meta_json: string }
  expect(JSON.parse(audit.meta_json)).toMatchObject({ sourceChannelId: 'general', sourceMessageId: 'public-message' })
  expect(await taskSourceFor(env, await member('bob'), task.id)).toMatchObject({ state: 'available', channelName: '#general', path: '/channels/general?message=public-message', authorName: 'Bob' })
  expect(await taskLinksForChannel(env, await member('bob'), 'general')).toEqual([{ taskId: task.id, number: task.number, title: 'From chat', messageId: 'public-message' }])
})

it('shows a member without access that a source exists but nothing about it', async () => {
  const task = await taskFrom('secret-message')
  expect(await taskSourceFor(env, await member('ada'), task.id)).toMatchObject({ state: 'available', channelName: '#secret' })
  expect(await taskSourceFor(env, await member('bob'), task.id)).toEqual({ state: 'restricted' })
  await expect(taskLinksForChannel(env, await member('bob'), 'secret')).rejects.toMatchObject({ statusCode: 404 })
})

it('keeps the task when its source message is deleted and says so', async () => {
  const task = await taskFrom('public-message')
  db.exec("UPDATE messages SET deleted_at='2026-10-26', content='' WHERE id='public-message'")
  expect(await taskSourceFor(env, await member('ada'), task.id)).toEqual({ state: 'deleted', channelName: '#general', path: '/channels/general' })
  db.exec("DELETE FROM attachments; DELETE FROM messages WHERE id='public-message'")
  expect(await taskSourceFor(env, await member('ada'), task.id)).toMatchObject({ state: 'deleted' })
})

it('hides message backlinks to tasks the viewer cannot read', async () => {
  await taskFrom('public-message')
  expect(await taskLinksForChannel(env, await member('chat'), 'general')).toEqual([])
})

it('creates no source for an ordinary task', async () => {
  const actor = await member('ada')
  const task = await createTask(env, actor.authorization, 'board', { title: 'Plain', description: '', priority: 'normal', dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [] }, () => {})
  expect(await taskSourceFor(env, actor, task.id)).toBeNull()
})
