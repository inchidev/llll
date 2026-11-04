import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { agentImageResolver } from '../../server/utils/agent-images'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { serveMcpRequest } from '../../server/utils/mcp-server'
import { spaceUsage } from '../../server/utils/space-quota'
import { loadTaskDetail, withTaskFrames } from '../../server/utils/task-data'
import { createRecordingKey, recordingKeyOf, recordingKeyRequest, rememberRecordingBoard, revokeRecordingKey } from '../../server/utils/recording-keys'
import { createRecording, createTaskFromRecording, finishRecording, readRecordingSettings, recordingLimits, saveRecordingSettings } from '../../server/utils/task-recordings'
import { createTask, findTasks, updateTask } from '../../server/utils/task-service'
import { enforceRoutePolicy } from '../../server/utils/route-gate'
import { splitAgentImageMarkers } from '../../shared/agent-images'
import type { AuthorizationContext } from '../../shared/authorization'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { coverFrame, recordingText, recordingTitle, runFrames, sniffRecordingType } from '../../shared/task-recordings'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

const state = vi.hoisted(() => ({ env: null as unknown, current: null as unknown, body: {} as unknown }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env, waitUntil: () => {} }) }))
vi.mock('../../server/utils/auth', async original => ({ ...await original<typeof import('../../server/utils/auth')>(), currentUser: async () => state.current, requireUser: async () => state.current }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => {
  const { requireMemberForUser: load } = await import('../../server/utils/channel-access')
  return load(state.env as L4Env, state.current as never, '00000000-0000-4000-8000-000000000001')
} }))

const SERVER = '00000000-0000-4000-8000-000000000001'
const HQ = '00000000-0000-4000-8000-00000000000d'
const SALES = '00000000-0000-4000-8000-0000000000a1'
const NOW = '2026-11-01T00:00:00.000Z'
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const noop = () => {}
const clip = { start: 1, end: 2, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, comment: 'Pay now does nothing' }

let db: DatabaseSync, env: L4Env, bucket: Map<string, Uint8Array>
const as = async (id: string, mcp = false): Promise<AuthorizationContext> => (await loadAuthorizationContext(env, { principalId: id, credential: mcp ? { kind: 'mcp', id: 'token', scopes: ['tasks:read', 'tasks:write'] } : { kind: 'session', id: 's' } }))!
const code = (work: Promise<unknown>) => work.then(() => 200, (error: { statusCode?: number }) => error.statusCode)
const upload = async (who: string, taskId: string, bytes = MP4, size = bytes.length) => createRecording(env, await as(who), taskId, bytes as unknown as ReadableStream<Uint8Array>, size, 'my screen.mov', noop)
const newTask = async (who: string, boardId: string, projectId: string | null = null, title = 'Recording') => createTask(env, await as(who), boardId, { title, description: '', priority: 'normal', dueAt: null, assigneeId: null, channelId: null, projectId, labelIds: [], dependencyIds: [] }, noop)

/** A frame arrives through the ordinary attachment route; here, its row and bytes. */
function addFrame(taskId: string, sourceId: string, name: string, marks: { clip: number; t: number; zoom: boolean }) {
  const id = `frame-${name.replace('.jpg', '')}-${taskId}`.slice(0, 60), key = `${SERVER}/tasks/${taskId}/${id}`
  bucket.set(key, JPEG)
  db.prepare("INSERT INTO task_attachments(id,task_id,uploader_id,r2_key,filename,content_type,size_bytes,role,source_id,marks_json,created_at) VALUES(?,?,(SELECT created_by FROM tasks WHERE id=?),?,?,'image/jpeg',?,'frame',?,?,?)")
    .run(id, taskId, taskId, key, name, JPEG.length, sourceId, JSON.stringify(marks), NOW)
  return id
}
async function recorded(who: string, boardId: string, projectId: string | null = null) {
  const task = await newTask(who, boardId, projectId)
  const recording = await upload(who, task.id)
  const frames = [addFrame(task.id, recording.id, 'c1-01.jpg', { clip: 1, t: 1, zoom: false }), addFrame(task.id, recording.id, 'c1-zoom.jpg', { clip: 1, t: 1, zoom: true })]
  const finished = await finishRecording(env, await as(who), recording.id, { duration: 12.5, clips: [clip], transcript: [{ start: 5, end: 6, text: 'and it spins' }] }, noop)
  return { task: finished, recording, frames }
}

beforeEach(() => {
  for (const [name, value] of Object.entries({ asRpc: (stub: unknown) => stub, useRuntimeConfig: () => ({}) })) vi.stubGlobal(name, value)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string; data: unknown }) => Object.assign(new Error(input.statusMessage), input))
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (event: { params: Record<string, string> }, key: string) => event.params[key])
  vi.stubGlobal('readBody', async () => state.body)
  vi.stubGlobal('getHeader', () => undefined)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  // Dana is in the default Space, Sam only in Sales, Olga the Owner only in the default Space.
  // Every Role here is wide, so only the Space boundary can keep one from the other's Tasks.
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system,mentionable) VALUES
      ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1,0),
      ('member-role','member','Member',112,'{}',1,0),
      ('wide','custom:wide','Wide',${ALL_PERMISSIONS & ~Permission.manageServer},'{}',0,1),
      ('reader','custom:reader','Reader',${Permission.readTasks | Permission.readProjects},'{}',0,1),
      ('no-files','custom:nofiles','No files',${Permission.readTasks | Permission.writeTasks | Permission.readProjects},'{}',0,1);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('olga','human','Olga','active','owner-role','${NOW}'),('dana','human','Dana','active','wide','${NOW}'),('sam','human','Sam','active','wide','${NOW}'),
      ('rita','human','Rita','active','reader','${NOW}'),('nils','human','Nils','active','no-files','${NOW}');
    INSERT INTO users(id,kind,display_name,status,created_at,updated_at) VALUES ('newcomer','human','Newcomer','pending','${NOW}','${NOW}');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
    INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Fixture','olga');
    INSERT INTO spaces(id,name) VALUES('${SALES}','Sales');
    DELETE FROM space_members WHERE user_id='sam';
    INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES('${SALES}','sam','member','${NOW}');
    INSERT INTO channels(id,space_id,name,type,visibility) VALUES('hq-general','${HQ}','general','text','server'),('sales-general','${SALES}','general','text','server');
    INSERT INTO projects(id,space_id,name,created_by,created_at,updated_at) VALUES
      ('hq-project','${HQ}','Headquarters','olga','${NOW}','${NOW}'),('sales-project','${SALES}','Deals','olga','${NOW}','${NOW}');
    INSERT INTO task_boards(id,space_id,name,position,created_by,created_at,updated_at) VALUES
      ('hq-board','${HQ}','HQ',1,'olga','${NOW}','${NOW}'),('sales-board','${SALES}','Sales',2,'olga','${NOW}','${NOW}');`)
  bucket = new Map()
  const info = (key: string, bytes: Uint8Array) => ({ key, size: bytes.length, etag: 'e', httpEtag: '"e"', uploaded: new Date() })
  const files = {
    async put(key: string, value: Uint8Array) { bucket.set(key, value) },
    async get(key: string, options?: { range?: { offset: number; length: number } }) { const bytes = bucket.get(key); if (!bytes) return null; const part = options?.range ? bytes.subarray(options.range.offset, options.range.offset + options.range.length) : bytes; return { ...info(key, bytes), arrayBuffer: async () => part.slice().buffer } },
    async head(key: string) { const bytes = bucket.get(key); return bytes ? info(key, bytes) : null },
    async delete(keys: string | string[]) { for (const key of [keys].flat()) bucket.delete(key) },
    async list() { return { objects: [], truncated: false } },
  }
  env = { DB: d1(db), FILES: files, SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {}, notifyMembersChanged: async () => {} }) } } as unknown as L4Env
  state.env = env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

describe('a recording on a Task', () => {
  it('is an attachment of the Task, with frames and marks, and the words in the Task’s text', async () => {
    const { task, recording, frames } = await recorded('dana', 'hq-board')
    expect(task.description).toBe('Clip 1 · 0:01.0–0:02.0 · box at x 10% y 20% size 30% × 40%: Pay now does nothing\nSaid 0:05.0–0:06.0: and it spins')
    const detail = (await loadTaskDetail(env, task.id))!
    const stored = detail.attachments.find(item => item.id === recording.id)!
    expect(stored).toMatchObject({ role: 'recording', contentType: 'video/mp4', filename: 'my_screen.mov', url: `/api/task-files/${recording.id}` })
    expect(stored.marks).toEqual({ duration: 12.5, clips: [clip] })
    expect(detail.attachments.filter(item => item.role === 'frame').map(item => item.sourceId)).toEqual([recording.id, recording.id])
    expect(detail.attachmentCount).toBe(1)
    expect(detail.coverAttachmentId).toBe(frames[1])
    expect(JSON.stringify(detail)).not.toContain(`${SERVER}/tasks`)
  })

  it('keeps a cover someone already chose, refuses one from elsewhere, and clears when it goes', async () => {
    const { task, frames, recording } = await recorded('dana', 'hq-board')
    const auth = await as('dana')
    await updateTask(env, auth, task.id, { coverAttachmentId: frames[0] }, noop)
    await finishRecording(env, auth, recording.id, { clips: [] }, noop)
    expect((await loadTaskDetail(env, task.id))!.coverAttachmentId).toBe(frames[0])
    const other = await recorded('dana', 'hq-board')
    expect(await code(updateTask(env, auth, task.id, { coverAttachmentId: other.frames[0] }, noop))).toBe(400)
    expect(await code(updateTask(env, auth, task.id, { coverAttachmentId: recording.id }, noop))).toBe(400)
    db.exec('PRAGMA foreign_keys=ON')
    db.prepare('DELETE FROM task_attachments WHERE id=?').run(recording.id)
    const after = (await loadTaskDetail(env, task.id))!
    expect(after.coverAttachmentId).toBeNull()
    expect(after.attachments).toEqual([])
  })

  it('makes a screenshot its own cover', async () => {
    const task = await newTask('dana', 'hq-board')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    const recording = await upload('dana', task.id, png)
    expect((await finishRecording(env, await as('dana'), recording.id, { clips: [] }, noop)).coverAttachmentId).toBe(recording.id)
  })

  it('names the type from the bytes and refuses anything else, leaving nothing behind', async () => {
    const task = await newTask('dana', 'hq-board')
    expect(sniffRecordingType(new TextEncoder().encode('<svg onload="alert(1)"></svg>     '))).toBeNull()
    expect(await code(upload('dana', task.id, new TextEncoder().encode('#!/bin/sh\nrm -rf /tmp/thing\n')))).toBe(415)
    expect(bucket.size).toBe(0)
  })

  it('goes past the 10 MB file cap up to its own configurable limit', async () => {
    const task = await newTask('dana', 'hq-board')
    expect((await recordingLimits(env)).maxUploadBytes).toBe(100 * 1024 * 1024)
    expect(await code(upload('dana', task.id, MP4, 50 * 1024 * 1024))).toBe(200)
    await saveRecordingSettings(env, await as('olga'), { maxUploadMb: 1 })
    expect(await readRecordingSettings(env)).toEqual({ maxUploadMb: 1 })
    expect(await code(upload('dana', task.id, MP4, 2 * 1024 * 1024))).toBe(413)
    expect(await code(saveRecordingSettings(env, await as('olga'), { maxUploadMb: 0 }))).toBe(400)
  })

  it('takes what a Task’s files take: Write tasks and Attach files', async () => {
    const task = await newTask('dana', 'hq-board')
    expect(await code(upload('rita', task.id))).toBe(403)
    expect(await code(upload('nils', task.id))).toBe(403)
    expect(bucket.size).toBe(0)
  })

  it('titles a new Task from the first thing written or said', () => {
    expect(recordingTitle([clip], [], false)).toBe('Pay now does nothing')
    expect(recordingTitle([], [{ start: 0, end: 1, text: 'It spins' }], false)).toBe('It spins')
    expect(recordingTitle([], [], true)).toBe('Screenshot')
    expect(recordingText({ duration: null, clips: [{ ...clip, box: null, comment: '' }] }, [], true)).toBe('Clip 1 · on the screenshot: (no comment)')
  })
})

describe('a recording from a phone', () => {
  // Of these, 13 load the person's authority, as every route does. It was 38 with the Task loaded back.
  const TRIPS = 29
  const arrive = async (who: string, spaceId = HQ, chosen: string | null = null, bytes = MP4, size = bytes.length) =>
    createTaskFromRecording(env, await as(who), spaceId, chosen, bytes as unknown as ReadableStream<Uint8Array>, size, 'RPReplay.mov', noop)
  const shotsBoards = (spaceId: string) => db.prepare("SELECT id FROM task_boards WHERE space_id=? AND name='Shots'").all(spaceId)
  const taskCount = () => (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
  const keyed = (token: string) => ({ method: 'POST', path: `/api/recordings?key=${token}`, context: {} }) as never

  it('becomes a Task on the Space’s Shots board, made once, and takes its title from the marks', async () => {
    const first = await arrive('dana')
    expect((await loadTaskDetail(env, first.taskId))!.title).toBe('Screen recording')
    expect(shotsBoards(HQ)).toHaveLength(1)
    expect((await arrive('dana')).boardId).toBe(first.boardId)
    expect(shotsBoards(HQ)).toHaveLength(1)
    const audit = db.prepare("SELECT meta_json AS meta FROM audit_log WHERE action='task_attachment.create' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { meta: string }
    expect(JSON.parse(audit.meta).storeMs).toBeGreaterThanOrEqual(0)
    const marked = await finishRecording(env, await as('dana'), first.attachment.id, { duration: 3, clips: [clip] }, noop)
    expect(marked.title).toBe('Pay now does nothing')
    expect(marked.id).toBe(first.taskId)
  })

  it('lands at the top of the backlog, above what is already there', async () => {
    const first = await arrive('dana')
    const second = await arrive('dana')
    const position = (id: string) => (db.prepare('SELECT position, status FROM tasks WHERE id=?').get(id) as { position: number, status: string })
    expect(position(second.taskId).status).toBe('backlog')
    expect(position(second.taskId).position).toBeLessThan(position(first.taskId).position)
  })

  it('keeps the phone’s wait short: no more database trips than this', async () => {
    await arrive('dana')
    const real = env.DB
    let trips = 0
    const count = <T extends object>(target: T): T => new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (key === 'batch' || key === 'first' || key === 'all' || key === 'run' || key === 'raw') trips++
        const result = value.apply(object, args)
        return key === 'prepare' || key === 'bind' ? count(result) : result
      }
    } })
    env.DB = count(real)
    await arrive('dana')
    env.DB = real
    expect(trips).toBeLessThanOrEqual(TRIPS)
  })

  it('leaves a title someone wrote, and calls a screenshot a screenshot', async () => {
    const shot = await arrive('dana', HQ, null, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))
    expect((await loadTaskDetail(env, shot.taskId))!.title).toBe('Screenshot')
    await updateTask(env, await as('dana'), shot.taskId, { title: 'Mine' }, noop)
    expect((await finishRecording(env, await as('dana'), shot.attachment.id, { duration: null, clips: [clip] }, noop)).title).toBe('Mine')
  })

  it('goes to the board this device chose, and back to Shots when that board is gone or out of reach', async () => {
    expect((await arrive('dana', HQ, 'hq-board')).boardId).toBe('hq-board')
    db.exec("UPDATE task_boards SET archived_at='2026-11-02T00:00:00.000Z' WHERE id='hq-board'")
    const archived = await arrive('dana', HQ, 'hq-board')
    expect(archived.boardId).not.toBe('hq-board')
    expect(db.prepare('SELECT name FROM task_boards WHERE id=?').get(archived.boardId)).toEqual({ name: 'Shots' })
    expect((await arrive('dana', HQ, 'sales-board')).boardId).toBe(archived.boardId)
  })

  it('leaves nothing behind when the file is refused', async () => {
    const before = taskCount()
    expect(await code(arrive('dana', HQ, null, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])))).toBe(415)
    expect(await code(arrive('dana', HQ, null, MP4, 0))).toBe(411)
    expect(await code(arrive('dana', HQ, null, MP4, 1024 * 1024 * 1024))).toBe(413)
    expect(taskCount()).toBe(before)
    expect([...bucket.keys()]).toEqual([])
    expect(shotsBoards(HQ)).toHaveLength(0)
  })

  it('needs what any recording needs, and makes no board for someone who can’t use it', async () => {
    expect(await code(arrive('nils'))).toBe(403)
    expect(await code(arrive('rita'))).toBe(403)
    expect(shotsBoards(HQ)).toHaveLength(0)
    db.exec("INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system,mentionable) VALUES('one-board','custom:one','One board'," + (Permission.readTasks | Permission.writeTasks | Permission.attachFiles) + ",'{\"boards\":[\"hq-board\"]}',0,1); UPDATE users SET role_id='one-board' WHERE id='nils'")
    expect((await arrive('nils')).boardId).toBe('hq-board')
    expect(shotsBoards(HQ)).toHaveLength(0)
  })

  it('stays in its Space: Sales gets its own board, and a board in another Space can’t be remembered', async () => {
    const hq = await arrive('dana'), sales = await arrive('sam', SALES)
    expect(sales.boardId).not.toBe(hq.boardId)
    expect(db.prepare('SELECT space_id AS spaceId FROM task_boards WHERE id=?').get(sales.boardId)).toEqual({ spaceId: SALES })
    const key = await createRecordingKey(env, 'sam', SALES, 'iPhone')
    expect(await code(rememberRecordingBoard(env, 'sam', key.id, 'hq-board'))).toBe(404)
    expect(await code(rememberRecordingBoard(env, 'dana', key.id, 'sales-board'))).toBe(404)
    expect(await code(revokeRecordingKey(env, 'dana', key.id))).toBe(404)
  })

  it('a key is only its digest, works on its one route, and stops when turned off', async () => {
    const key = await createRecordingKey(env, 'dana', HQ, 'iPhone')
    expect(key.token).toMatch(/^l4rec_[0-9a-f]{64}$/u)
    expect(JSON.stringify(db.prepare('SELECT * FROM mcp_access_tokens WHERE id=?').get(key.id))).not.toContain(key.token)
    const event = keyed(key.token)
    expect(await recordingKeyRequest(event)).toMatchObject({ id: key.id, userId: 'dana', spaceId: HQ })
    expect(recordingKeyOf(event)).toMatchObject({ id: key.id })
    expect(await recordingKeyRequest({ method: 'GET', path: `/api/recordings?key=${key.token}`, context: {} } as never)).toBeUndefined()
    expect(await recordingKeyRequest({ method: 'POST', path: `/api/me?key=${key.token}`, context: {} } as never)).toBeUndefined()
    expect(await recordingKeyRequest(keyed('l4rec_' + '0'.repeat(64)))).toBeNull()
    expect(await recordingKeyRequest(keyed('wrong'))).toBeNull()
    await revokeRecordingKey(env, 'dana', key.id)
    expect(await recordingKeyRequest(keyed(key.token))).toBeNull()
  })

  it('the gate refuses a key once its person has left the Space', async () => {
    const key = await createRecordingKey(env, 'dana', SALES, 'iPhone')
    state.current = { id: 'dana', kind: 'human', displayName: 'Dana', avatarR2Key: null, status: 'active' }
    const event = { path: '/api/recordings', method: 'POST', context: { recordingKey: { id: key.id, userId: 'dana', spaceId: SALES, boardId: null } }, node: { req: { headers: {} } } } as never
    expect(await code(enforceRoutePolicy(event))).toBe(401)
  })
})

describe('agents', () => {
  const callTask = async (who: string, taskId: string) => {
    const authorization = await as(who, true)
    const principal = { tokenId: 'token', userId: who, serverId: SERVER, roleId: authorization.principal.roleId, roleName: authorization.principal.roleName, perms: authorization.principal.permissions, isOwner: authorization.principal.isOwner, scopes: ['tasks:read', 'tasks:write'], delegatedBy: null, authorization }
    const response = await serveMcpRequest(new Request('https://server.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: 'server.test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task', arguments: { taskId } } }) }), { env, principal: principal as never, schedule: noop, origin: 'https://server.test' })
    const text = await response.text()
    return (JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as { result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean } }).result
  }

  it('get_task returns frames as images, the marks and the words', async () => {
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, 'wide')
    const { task } = await recorded('dana', 'hq-board')
    const answer = await callTask('dana', task.id)
    const json = JSON.parse(answer.content[0]!.text!) as { task: { description: string; attachments: Array<{ role: string; marks: unknown }> } }
    expect(json.task.description).toContain('and it spins')
    expect(json.task.attachments.find(item => item.role === 'recording')!.marks).toEqual({ duration: 12.5, clips: [clip] })
    expect(answer.content.filter(item => item.type === 'image').map(item => item.mimeType)).toEqual(['image/jpeg', 'image/jpeg'])
    expect(answer.content.some(item => item.text === 'frame c1-zoom.jpg')).toBe(true)
  })

  it('list_tasks finds the newest recorded Tasks by Project, leaves finished ones out, and says when a name matches nothing', async () => {
    const auth = await as('dana')
    const plain = await newTask('dana', 'hq-board', 'hq-project', 'Plain')
    const older = await recorded('dana', 'hq-board', 'hq-project')
    const elsewhere = await recorded('dana', 'hq-board')
    const found = await findTasks(env, auth, { hasRecording: true, limit: 10 })
    expect(found.tasks.map(task => task.id).sort()).toEqual([older.task.id, elsewhere.task.id].sort())
    expect((await findTasks(env, auth, { hasRecording: false, limit: 10 })).tasks.map(task => task.id)).toEqual([plain.id])
    expect((await findTasks(env, auth, { names: new Set(['headquarters']), hasRecording: true, limit: 10 })).tasks.map(task => task.id)).toEqual([older.task.id])
    const unknown = await findTasks(env, auth, { names: new Set(['some-folder']), hasRecording: true, limit: 10 })
    expect(unknown.note).toContain('some-folder')
    expect(unknown.tasks).toHaveLength(2)
    await updateTask(env, auth, older.task.id, { status: 'done' }, noop)
    expect((await findTasks(env, auth, { names: new Set(['headquarters']), hasRecording: true, limit: 10 })).tasks).toEqual([])
    expect((await findTasks(env, auth, { status: 'done', limit: 10 })).tasks.map(task => task.id)).toEqual([older.task.id])
    expect((await findTasks(env, auth, { limit: 1 })).tasks).toHaveLength(1)
  })

  it('a Task with no recording answers as it always did', async () => {
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, 'wide')
    const task = await newTask('dana', 'hq-board')
    expect((await callTask('dana', task.id)).content).toHaveLength(1)
  })

  it('a Run on the Task gets its frames, and no other Run can read them', async () => {
    const { task, frames } = await recorded('dana', 'hq-board')
    const other = await newTask('dana', 'hq-board')
    const prompt = await withTaskFrames(env, task.id, `${task.title}\n\n${task.description}`)
    expect(prompt).toContain('and it spins')
    expect(splitAgentImageMarkers(prompt).filter(part => part.type === 'image').map(part => (part as { id: string }).id)).toEqual(frames)
    expect(await withTaskFrames(env, other.id, 'plain')).toBe('plain')
    const read = (taskId: string | null) => agentImageResolver(env, { channelId: 'hq-general', initiatedBy: 'dana', taskId }, async () => true).parts(`[l4-image:${frames[0]}]`)
    expect((await read(task.id) as Array<{ type: string }>)[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' })
    expect((await read(other.id) as Array<{ type: string }>)[0]).toMatchObject({ type: 'text' })
    expect((await read(null) as Array<{ type: string }>)[0]).toMatchObject({ type: 'text' })
  })

  it('picks the close-up for the cover and first for a Run', () => {
    const frames = Array.from({ length: 30 }, (_, index) => ({ id: `f${index}`, marks: { clip: 1, t: index, zoom: index === 29 } }))
    expect(coverFrame(frames)!.id).toBe('f29')
    const picked = runFrames(frames, 4)
    expect(picked).toHaveLength(4)
    expect(picked.at(-1)!.id).toBe('f29')
  })
})

describe('two Spaces', () => {
  it('keeps a recorded Task and its frames from a Member of another Space, the Owner included', async () => {
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, 'wide')
    const { task, recording, frames } = await recorded('sam', 'sales-board', 'sales-project')
    const gate = async (who: string, path: string, method = 'GET') => {
      state.current = { id: who, kind: 'human', displayName: who, avatarR2Key: null, status: 'active' }
      return code(enforceRoutePolicy({ path, method, context: {}, node: { req: { headers: {} } } } as never))
    }
    for (const [path, method] of [[`/api/tasks/${task.id}`, 'GET'], [`/api/tasks/${task.id}/recording`, 'POST'], [`/api/tasks/${task.id}/attachments`, 'POST'], [`/api/task-files/${recording.id}`, 'GET'], [`/api/task-files/${frames[0]}`, 'GET'], [`/api/task-attachments/${recording.id}/finish`, 'POST'], [`/api/task-attachments/${recording.id}`, 'DELETE']] as const) {
      for (const outsider of ['dana', 'olga']) expect(await gate(outsider, path, method), `${outsider} ${method} ${path}`).toBe(404)
      expect(await gate('sam', path, method), `${method} ${path}`).toBe(200)
    }
    for (const outsider of ['dana', 'olga']) {
      expect(await code(upload(outsider, task.id))).not.toBe(200)
      expect(await code(finishRecording(env, await as(outsider), recording.id, { clips: [] }, noop))).not.toBe(200)
    }
  })

  it('finds nothing in another Space through list_tasks, not even by its repository’s name', async () => {
    await recorded('dana', 'hq-board', 'hq-project')
    await recorded('sam', 'sales-board', 'sales-project')
    db.exec(`INSERT INTO project_repositories(id,project_id,provider,host,external_id,slug,default_branch,created_by,created_at) VALUES('r','sales-project','github','https://github.com','1','acme/invoices','main','olga','${NOW}')`)
    const dana = await findTasks(env, await as('dana'), { names: new Set(['invoices']), hasRecording: true, limit: 10 })
    expect(dana.note).toContain('invoices')
    expect(dana.tasks.map(task => task.projectId)).toEqual(['hq-project'])
    expect((await findTasks(env, await as('sam'), { names: new Set(['invoices']), hasRecording: true, limit: 10 })).tasks.map(task => task.projectId)).toEqual(['sales-project'])
  })

  it('counts a recording and its frames against its own Space’s storage, and stops at the limit', async () => {
    const task = await newTask('sam', 'sales-board', 'sales-project')
    const recording = await upload('sam', task.id)
    addFrame(task.id, recording.id, 'c1-01.jpg', { clip: 1, t: 0, zoom: false })
    expect((await spaceUsage(env, SALES)).storageBytes).toBe(MP4.length + JPEG.length)
    expect((await spaceUsage(env, HQ)).storageBytes).toBe(0)
    db.exec(`UPDATE spaces SET storage_limit_bytes=${MP4.length + JPEG.length} WHERE id='${SALES}'`)
    const before = bucket.size
    expect(await code(upload('sam', task.id))).toBe(429)
    expect(bucket.size).toBe(before)
    const hq = await newTask('dana', 'hq-board')
    expect(await code(upload('dana', hq.id))).toBe(200)
  })

  it('files a recording’s record in its Space’s audit log', async () => {
    await recorded('sam', 'sales-board', 'sales-project')
    expect(db.prepare("SELECT DISTINCT space_id AS spaceId FROM audit_log WHERE action='task_attachment.create'").all()).toEqual([{ spaceId: SALES }])
  })
})

describe('a Project invite', () => {
  async function invite(by: string, projectId: string) {
    state.current = { id: by, kind: 'human', displayName: by, avatarR2Key: null }
    state.body = { projectId, maxUses: 5, expiresInHours: 168 }
    const handler = (await import('../../server/api/servers/[id]/invites.post')).default as unknown as (event: unknown) => Promise<{ invite: { code: string } }>
    return handler({ params: { id: SERVER }, path: `/api/servers/${SERVER}/invites`, method: 'POST', context: {} })
  }
  async function accept(who: string, inviteCode: string) {
    state.current = { id: who, kind: 'human', displayName: who, avatarR2Key: null }
    const handler = (await import('../../server/api/invites/[code]/accept.post')).default as unknown as (event: unknown) => Promise<{ channelId: string; projectId: string | null }>
    return handler({ params: { code: inviteCode }, context: {} })
  }

  it('joins the Project’s Space and grants the Project, so the newcomer can act on its Tasks', async () => {
    db.exec(`INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES('${SALES}','olga','member','${NOW}')`)
    const { task } = await recorded('sam', 'sales-board', 'sales-project')
    const made = await invite('olga', 'sales-project')
    expect(await accept('newcomer', made.invite.code)).toMatchObject({ channelId: 'sales-general', projectId: 'sales-project' })
    expect(db.prepare("SELECT space_id AS id FROM space_members WHERE user_id='newcomer'").all()).toEqual([{ id: SALES }])
    const newcomer = await as('newcomer')
    expect((await updateTask(env, newcomer, task.id, { status: 'review' }, noop)).status).toBe('review')
    // The Coordinator policy and the default Member Role are enough to send a recording.
    expect((await upload('newcomer', task.id)).contentType).toBe('video/mp4')
  })

  it('cannot be made for a Project in a Space the inviter is outside of', async () => {
    expect(await code(invite('dana', 'sales-project'))).toBe(403)
    expect(db.prepare('SELECT count(*) AS n FROM invites').get()).toEqual({ n: 0 })
  })
})
