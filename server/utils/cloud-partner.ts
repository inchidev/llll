import { z } from 'zod'
import { memberIdentitySchema, type MemberIdentity } from '../../shared/cloud-seed'
import { newId, nowIso } from '../../shared/ids'
import { fileStorage } from '../../shared/file-storage'
import { sniffMime } from '../../shared/mime'
import { hasPermission, Permission } from '../../shared/permissions'
import { getServerId } from '../../shared/server-id'
import { isCloudHosted } from '../../shared/server-runtime'
import { DEFAULT_SPACE_ID, reachableSpaceIds } from '../../shared/spaces'
import { sniffRecordingType } from '../../shared/task-recordings'
import type { AuthorizationContext } from '../../shared/authorization'
import type { RunEnvironment } from '../../shared/code-environments'
import { cloudflareNetwork, type L4Env } from '../../workers/env'
import { signalTasksChanged } from '../../workers/task-events'
import { createAgentRun } from './agent-run-service'
import { loadAuthorizationContext } from './authorization'
import { fail } from './cf'
import { applyPartnerConfig, partnerAgentId } from './cloud-seed'
import { createProjectRepository, starterFilesSchema, type StarterFiles, listProjectReleases, projectArtifactsRepository, requireArtifacts, withRepository } from './factory-artifacts'
import { ensureL4PlacementNode } from './l4-compute'
import { findMemberByIdentity } from './member-identities'
import { readableMentions } from './member-names'
import { requireMessageMember, sendChannelMessage } from './message-service'
import { writeAudit } from './messages'
import { boundedBytes, fetchPreview } from './preview-fetch'
import { publishTarget, repositoryGitFlow } from './project-git-flow'
import { createProject, ensureFirstBoard, projectPermission, requireProject } from './project-service'
import { assignProjectPolicy } from './project-policies'
import { spaceOfResource } from './space-access'
import { requireStorageQuota } from './space-quota'
import { ensureTaskDiscussion } from './task-discussion'
import { firstTaskPosition } from './task-policy'
import { getTask, insertTask } from './task-service'

/**
 * The partner's game doors on a hosted Server (L4 Cloud's AfterPrompt): a creator, named by their identity, makes
 * a Project with its own repository in L4 (ADR 0013), gives the partner's Agent a Task on it, talks to it in the
 * Task's discussion and reads back where the work stands. Every action acts as that Member, with the Member's own
 * permissions, as a person would from the interface: nothing here grants anything. Agents wake from this Server.
 */
type Schedule = (promise: Promise<unknown>) => void
type Answer = Record<string, unknown>

const ID = /^[A-Za-z0-9_-]{1,64}$/u
const id = z.string().regex(ID)
const requestId = z.string().trim().min(1).max(128)
/** Signed links last an hour and hold up to about 95 MB; a little room above that. */
export const PARTNER_ATTACHMENT_BYTES = 100 * 1024 * 1024
const ATTACHMENT_FETCH_MS = 25_000
const DAY_MS = 86_400_000

const projectCreateBody = z.object({ identity: memberIdentitySchema, requestId, title: z.string().trim().min(1).max(200), files: starterFilesSchema.default([]) }).strict()
const projectGetBody = z.object({ identity: memberIdentitySchema, projectId: id }).strict()
const taskCreateBody = z.object({
  identity: memberIdentitySchema, requestId, projectId: id,
  title: z.string().trim().min(1).max(200), body: z.string().max(12_000).default(''),
  links: z.array(z.string().url().max(2000)).max(20).default([]),
  attachments: z.array(z.object({ url: z.string().url().max(4000), name: z.string().trim().min(1).max(200), contentType: z.string().max(200), size: z.number().int().min(0).max(PARTNER_ATTACHMENT_BYTES) }).strict()).max(10).default([]),
  agent: z.object({ name: z.string().trim().min(1).max(80) }).strict().nullish(),
  /** False: the Agent talks the idea through first, with no box and no Compute spent; a later message with `build` starts the work. */
  build: z.boolean().default(true),
}).strict()
const taskGetBody = z.object({ identity: memberIdentitySchema, taskId: id }).strict()
const taskMessageBody = z.object({ identity: memberIdentitySchema, requestId, taskId: id, text: z.string().trim().min(1).max(20_000), build: z.boolean().default(true) }).strict()
const projectFilesBody = z.object({ identity: memberIdentitySchema, projectId: id, ref: z.string().trim().min(1).max(200).optional(), path: z.string().max(1000).default('') }).strict()
const projectFileBody = z.object({ identity: memberIdentitySchema, projectId: id, ref: z.string().trim().min(1).max(200).optional(), path: z.string().trim().min(1).max(1000) }).strict()
/** What a chat-only turn is told, so the Agent talks instead of trying to work without its computer. */
const TALK_ONLY = 'This turn is a conversation only: you have no computer and no repository in it. Talk the idea through with the creator, ask what you need, and say when you are ready to build; the creator starts the build.'
/** The most of one file a partner reads, and of one folder it lists. */
const FILE_BYTES = 512 * 1024, FOLDER_ENTRIES = 1000
/** A chat message's own limit; a longer partner message goes into the discussion in parts and reaches the Agent whole. */
const CHAT_CHARS = 2000

/** The Member an identity names, as an active person, with the authority a signed-in session of theirs would have. */
async function actingMember(env: L4Env, identity: MemberIdentity) {
  const member = await findMemberByIdentity(env, identity)
  if (!member || member.status !== 'active' || member.kind !== 'human') fail(404, 'not_found', 'No Member has this identity')
  return { member: member!, auth: await sessionAuthorization(env, member!.id) }
}

/** What a signed-in session of this person could do, working in the default Space, where the partner's Agent is. */
async function sessionAuthorization(env: L4Env, principalId: string) {
  const auth = await loadAuthorizationContext(env, { principalId, credential: { kind: 'session' } })
  if (!auth) fail(404, 'not_found', 'No Member has this identity')
  if (auth!.spaces && !auth!.spaces.active && reachableSpaceIds(auth!).includes(DEFAULT_SPACE_ID)) auth!.spaces = { ...auth!.spaces, active: DEFAULT_SPACE_ID }
  return auth!
}

/** The Developer policy of every Server: work on a Project's Tasks and propose code, nothing Server-wide. */
const DEVELOPER_POLICY = 'project-policy-developer'

/**
 * Runs `work` once per action, identity and request ID within a day: a repeat answers what the first answered,
 * and one that arrives while the first is at work is told to wait. A refusal keeps nothing, so it can be retried.
 */
async function once(env: L4Env, action: string, identity: MemberIdentity, request: string, work: () => Promise<Answer>): Promise<Answer> {
  const key = `${identity.provider}\n${identity.subject}\n${request}`
  const now = nowIso()
  await env.DB.prepare('DELETE FROM cloud_relay_requests WHERE action=? AND request_id=? AND created_at<?').bind(action, key, new Date(Date.now() - DAY_MS).toISOString()).run()
  const claimed = await env.DB.prepare('INSERT INTO cloud_relay_requests(action,request_id,answer_json,created_at) VALUES(?,?,NULL,?) ON CONFLICT DO NOTHING RETURNING request_id')
    .bind(action, key, now).first()
  if (!claimed) {
    const row = await env.DB.prepare('SELECT answer_json AS answerJson FROM cloud_relay_requests WHERE action=? AND request_id=?').bind(action, key).first<{ answerJson: string | null }>()
    if (row?.answerJson) return JSON.parse(row.answerJson) as Answer
    fail(409, 'request_pending', 'This request is still being handled. Send it again shortly.')
  }
  try {
    const answer = await work()
    await env.DB.prepare('UPDATE cloud_relay_requests SET answer_json=? WHERE action=? AND request_id=?').bind(JSON.stringify(answer), action, key).run()
    return answer
  }
  catch (error) {
    await env.DB.prepare('DELETE FROM cloud_relay_requests WHERE action=? AND request_id=?').bind(action, key).run()
    throw error
  }
}

/** Answers older than a day are forgotten with the scheduled work. */
export async function pruneRelayRequests(env: L4Env) {
  const removed = await env.DB.prepare('DELETE FROM cloud_relay_requests WHERE created_at<?').bind(new Date(Date.now() - DAY_MS).toISOString()).run()
  return removed.meta.changes ?? 0
}

const status = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode
/** What a refusal says, for a Task's record. */
function refusalText(error: unknown, fallback: string) {
  const typed = error as { statusMessage?: string; data?: { error?: { message?: string } }; message?: string } | null
  return (typed?.data?.error?.message || typed?.statusMessage || (error instanceof Error ? error.message : '') || fallback).slice(0, 2000)
}

/** The game's repository in L4 and the ref to read: a branch, a tag or a commit, by default its base branch. */
async function gameRepository(env: L4Env, auth: AuthorizationContext, projectId: string, ref?: string) {
  await readableProject(env, auth, projectId)
  const repository = await projectArtifactsRepository(env, projectId)
  if (!repository) fail(404, 'not_found', 'This Project has no repository in L4')
  return { name: repository!.name, ref: ref ?? repository!.baseBranch }
}

/** One folder of the game's repository at a ref: folders first, then files, by name. An empty repository lists nothing. */
async function projectFiles(env: L4Env, auth: AuthorizationContext, input: z.infer<typeof projectFilesBody>) {
  const { name, ref } = await gameRepository(env, auth, input.projectId, input.ref)
  const path = input.path.split('/').filter(Boolean)
  if (path.some(part => part === '.' || part === '..')) fail(400, 'bad_request', 'Name a folder inside the repository')
  return withRepository(env, name, async repo => {
    const [head] = await repo.log({ ref, limit: 1 })
    if (!head) return { ref, sha: null, path: path.join('/'), entries: [] }
    let tree = head.treeHash
    for (const part of path) {
      const found = (await repo.readTree(tree))?.find(entry => entry.name === part && entry.type === 'tree')
      if (!found) fail(404, 'not_found', 'No such folder')
      tree = found!.hash
    }
    const entries = ((await repo.readTree(tree)) ?? []).filter(entry => entry.type !== 'gitlink')
      .map(entry => ({ name: entry.name, type: entry.type === 'tree' ? 'folder' as const : 'file' as const }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
    return { ref, sha: head.hash, path: path.join('/'), entries: entries.slice(0, FOLDER_ENTRIES), truncated: entries.length > FOLDER_ENTRIES }
  })
}

/** One file of the game's repository at a ref: its text when it is text and not too large, else only its size. */
async function projectFile(env: L4Env, auth: AuthorizationContext, input: z.infer<typeof projectFileBody>) {
  const { name, ref } = await gameRepository(env, auth, input.projectId, input.ref)
  const path = input.path.split('/').filter(Boolean)
  if (!path.length || path.some(part => part === '.' || part === '..')) fail(400, 'bad_request', 'Name a file inside the repository')
  return withRepository(env, name, async repo => {
    const blob = await repo.readFile({ ref, path: path.join('/') })
    if (!blob) fail(404, 'not_found', 'No such file')
    const size = blob!.size
    if (size > FILE_BYTES) return { ref, path: path.join('/'), size, text: null }
    const bytes = new Uint8Array(await blob!.arrayBuffer())
    return { ref, path: path.join('/'), size, text: utf8Text(bytes) }
  })
}

/** The bytes as UTF-8 text, or null for binary: a NUL byte or invalid UTF-8. */
function utf8Text(bytes: Uint8Array) {
  if (bytes.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return null }
}

/** A Project the Member may read, or 404: one they may not read is as missing as one that does not exist. */
async function readableProject(env: L4Env, auth: AuthorizationContext, projectId: string) {
  try { return await requireProject(env, auth, projectId) }
  catch (error) { if (status(error) === 403 || status(error) === 404) fail(404, 'not_found', 'Project not found'); throw error }
}

async function projectAnswer(env: L4Env, auth: AuthorizationContext, projectId: string) {
  const project = await readableProject(env, auth, projectId)
  const repository = await projectArtifactsRepository(env, projectId)
  const config = repository?.environmentId
    ? await env.DB.prepare('SELECT config_json AS config FROM agent_environments WHERE id=?').bind(repository.environmentId).first<{ config: string }>()
    : null
  let remote: string | null = null
  try { remote = config ? (JSON.parse(config.config) as { remote?: string }).remote ?? null : null } catch { /* A configuration that does not parse has no remote to show. */ }
  const { releases } = await listProjectReleases(env, auth, projectId)
  return {
    projectId: project.id,
    title: project.name.slice(0, 200),
    repository: repository && remote ? { url: remote, defaultBranch: repository.baseBranch } : null,
    releases: releases.map(release => ({ version: release.version.slice(0, 40), tag: release.tag, sha: release.sha, createdAt: new Date(release.createdAt).toISOString() })),
  }
}

/**
 * A Project for a game: made by the Member as from the Projects page, with a repository in L4 on the Server's
 * L4 Compute placement. It needs the same rights as there (the Owner has them; a Member needs Manage projects and
 * Manage server), checked before anything is made. A Project whose repository could not be made is removed again.
 */
async function createGameProject(env: L4Env, auth: AuthorizationContext, title: string, files: StarterFiles = []) {
  // A friend the creator invited into their Studio starts games too. The Owner, who invited them through the
  // partner, makes the Project and its repository, and the friend gets Developer access to that Project only.
  const ownerId = auth.principal.isOwner ? null : (await env.DB.prepare('SELECT owner_id AS id FROM server WHERE owner_id IS NOT NULL').first<{ id: string }>())?.id
  const maker = auth.principal.isOwner || !ownerId ? auth : await sessionAuthorization(env, ownerId)
  projectPermission(maker, true)
  if (!maker.principal.isOwner && !hasPermission(maker.principal.permissions, Permission.manageServer)) fail(403, 'code_denied', 'Server administration is required to connect repositories')
  requireArtifacts(env)
  const project = await createProject(env, maker, { name: title.slice(0, 100), description: '' })
  try {
    const computeNodeId = isCloudHosted(env) ? await ensureL4PlacementNode(env) : null
    await createProjectRepository(env, maker, project.id, computeNodeId ? { computeNodeId } : {}, files)
    await applyPartnerConfig(env, project.id, maker.principal.id)
    if (maker !== auth) await assignProjectPolicy(env, maker, project.id, { policyId: DEVELOPER_POLICY, memberId: auth.principal.id })
  }
  catch (error) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM grants WHERE project_id=?').bind(project.id),
      env.DB.prepare('DELETE FROM project_repositories WHERE project_id=?').bind(project.id),
      env.DB.prepare('DELETE FROM projects WHERE id=?').bind(project.id),
    ]).catch(() => undefined)
    throw error
  }
  return projectAnswer(env, maker !== auth ? await sessionAuthorization(env, auth.principal.id) : auth, project.id)
}

type TaskRow = { id: string; boardId: string; projectId: string | null; title: string; status: string; assigneeId: string | null; channelId: string | null; discussionChannelId: string | null; factoryState: string | null; lastError: string | null; updatedAt: string }
const taskColumns = 'id,board_id AS boardId,project_id AS projectId,title,status,assignee_id AS assigneeId,channel_id AS channelId,discussion_channel_id AS discussionChannelId,factory_state AS factoryState,last_error AS lastError,updated_at AS updatedAt'

/** A Task the Member may read, in a Project, or 404. */
async function readableTask(env: L4Env, auth: AuthorizationContext, taskId: string): Promise<TaskRow & { projectId: string }> {
  let visible: Awaited<ReturnType<typeof getTask>> = null
  try { visible = await getTask(env, auth, taskId) }
  catch (error) { if (status(error) !== 403 && status(error) !== 404) throw error }
  // A Task number is a reference too; the partner names Tasks only by ID.
  if (!visible || visible.id !== taskId || !visible.projectId) fail(404, 'not_found', 'Task not found')
  return (await env.DB.prepare(`SELECT ${taskColumns} FROM tasks WHERE id=?`).bind(taskId).first<TaskRow & { projectId: string }>())!
}

export type PartnerTaskState = 'open' | 'working' | 'waiting' | 'done' | 'failed'
/**
 * Where a Task stands for the partner. done: the Task is done. failed: the Task failed, its box was refused on
 * L4 Compute, its last Run failed, or it never got a Run because something refused it. waiting: a person is
 * asked for something, a review on the Task or the Agent's turn having ended. working: a Run is queued or
 * running. open: no Run yet.
 */
export function partnerTaskState(input: { status: string; factoryState: string | null; lastError: string | null; lastRun: string | null; reviewPending: boolean }): PartnerTaskState {
  if (input.status === 'done') return 'done'
  if (input.status === 'failed' || input.factoryState === 'l4_credit' || input.factoryState === 'l4_unreachable' || input.lastRun === 'failed') return 'failed'
  if (!input.lastRun && input.lastError) return 'failed'
  if (input.reviewPending || input.status === 'review') return 'waiting'
  if (input.lastRun === 'queued' || input.lastRun === 'running') return 'working'
  if (input.lastRun) return 'waiting'
  return 'open'
}

/** The Task's branch in its Project's repository: the latest box's, as its Git flow names it. */
async function taskBranch(env: L4Env, taskId: string) {
  const box = await env.DB.prepare('SELECT id,environment_json AS environmentJson FROM factory_boxes WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(taskId).first<{ id: string; environmentJson: string }>()
  if (!box) return null
  let environment: RunEnvironment
  try { environment = JSON.parse(box.environmentJson) as RunEnvironment } catch { return null }
  const { gitFlow } = await repositoryGitFlow(env, environment.id)
  const target = publishTarget(gitFlow, box.id, environment)
  return { name: target.ref, direct: 'direct' in target, environment }
}

/** The branch's own commits, newest first, read through the binding; none when it cannot be read. */
async function branchCommits(env: L4Env, branch: NonNullable<Awaited<ReturnType<typeof taskBranch>>>) {
  if (branch.environment.provider !== 'artifacts') return []
  try {
    return await withRepository(env, branch.environment.sourceRepo, async repo => {
      const [own, base] = await Promise.all([repo.log({ ref: branch.name, limit: 200 }), branch.direct ? [] : repo.log({ ref: branch.environment.baseBranch, limit: 200 })])
      const inBase = new Set(base.map(commit => commit.hash))
      return own.filter(commit => !inBase.has(commit.hash)).slice(0, 200).map(commit => ({
        sha: commit.hash, message: commit.message.slice(0, 2000), branch: branch.name,
        createdAt: new Date((commit.committedAt || commit.authoredAt) * 1000).toISOString(),
      }))
    })
  }
  catch { return [] }
}

type PartnerMessage = { id: string; author: 'agent' | 'member' | 'system'; name: string | null; text: string; createdAt: string }
/** The Run a Task's private-result notice points to, by the link the notice carries. */
const PRIVATE_NOTICE = /Private result available to the initiating Member\.\s*\[Open private Run\]\(\/runs\/([0-9a-f-]{36})\)/u
async function discussionMessages(env: L4Env, channelId: string | null, limit: number, reader: string | null = null): Promise<PartnerMessage[]> {
  if (!channelId || limit <= 0) return []
  const rows = (await env.DB.prepare(`SELECT m.id,m.content,m.created_at AS createdAt,u.kind,u.display_name AS name FROM messages m JOIN users u ON u.id=m.author_id
    WHERE m.channel_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC LIMIT ?`).bind(channelId, limit).all<{ id: string; content: string; createdAt: string; kind: string; name: string }>()).results.reverse()
  // A Task's Run posts only a notice: its answer is private to the Member who asked. The partner acts as one
  // Member, so the Member who started that Run reads its answer in its place, as they would on the Run's page.
  if (reader) {
    for (const row of rows) {
      const runId = row.kind === 'agent' ? PRIVATE_NOTICE.exec(row.content)?.[1] : undefined
      if (!runId) continue
      const run = await env.DB.prepare('SELECT result_text AS text,status,last_error AS error FROM agent_runs WHERE id=? AND initiated_by=?').bind(runId, reader).first<{ text: string | null; status: string; error: string | null }>()
      // A Run that ended without an answer says why, in the Server's words.
      if (run?.text) row.content = run.text
      else if (run && ['failed', 'cancelled'].includes(run.status)) row.content = `The Agent stopped: ${run.error || run.status}`
    }
  }
  const texts = await readableMentions(env, rows.map(row => row.content))
  return rows.map((row, index) => ({ id: row.id, author: row.kind === 'agent' ? 'agent' : 'member', name: row.name || null, text: (texts[index] ?? row.content).slice(0, 20_000), createdAt: row.createdAt }))
}

async function taskAnswer(env: L4Env, task: TaskRow & { projectId: string }, reader: string | null = null) {
  const [lastRun, review, branch] = await Promise.all([
    env.DB.prepare('SELECT status FROM agent_runs WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(task.id).first<{ status: string }>(),
    env.DB.prepare("SELECT 1 AS waiting FROM factory_approvals a JOIN factory_boxes b ON b.id=a.box_id WHERE b.task_id=? AND a.status IN ('pending','pending_diff') LIMIT 1").bind(task.id).first(),
    taskBranch(env, task.id),
  ])
  const state = partnerTaskState({ status: task.status, factoryState: task.factoryState, lastError: task.lastError, lastRun: lastRun?.status ?? null, reviewPending: Boolean(review) })
  // Why it failed, when the Task itself records it: the partner sees it as the Server's word in the discussion.
  const reason: PartnerMessage | null = state === 'failed' && task.lastError ? { id: `failed-${task.id}`, author: 'system', name: null, text: task.lastError.slice(0, 20_000), createdAt: task.updatedAt } : null
  const messages = await discussionMessages(env, task.discussionChannelId, reason ? 499 : 500, reader)
  return {
    taskId: task.id, projectId: task.projectId, title: task.title.slice(0, 200), state, branch: branch?.name ?? null,
    messages: reason ? [...messages, reason] : messages,
    commits: branch ? await branchCommits(env, branch) : [],
  }
}

/** The Task did not get its Agent: it is marked failed, with the reason, for the board and the partner. */
async function markTaskFailed(env: L4Env, task: { id: string; boardId: string }, reason: string) {
  await env.DB.prepare('UPDATE tasks SET status=\'failed\',last_error=?,position=?,updated_at=? WHERE id=?').bind(reason, await firstTaskPosition(env, task.boardId, 'failed'), nowIso(), task.id).run()
  await signalTasksChanged(env, task.boardId, task.id).catch(() => undefined)
}

const mayAttach = (auth: AuthorizationContext) => auth.principal.isOwner || hasPermission(auth.principal.permissions, Permission.attachFiles)
const safeName = (name: string) => name.replace(/[^\w.-]+/gu, '_').slice(0, 80) || 'file'

/**
 * One file the partner links to, fetched by this Server through its public-network guard and kept as the Task's
 * attachment, as an upload from the Task would be. Its type is read from its first bytes, never taken from the
 * link; a type L4 does not know is kept as plain bytes.
 */
async function attachFromLink(env: L4Env, auth: AuthorizationContext, task: { id: string; boardId: string }, spaceId: string | null, link: { url: string; name: string }) {
  let ownHosts: string[] = []
  try { ownHosts = [new URL(env.PUBLIC_ORIGIN || '').hostname].filter(Boolean) } catch { /* Without an origin no own host is known. */ }
  const signal = AbortSignal.timeout(ATTACHMENT_FETCH_MS)
  let response: Response
  try { response = await fetchPreview(link.url, ownHosts, PARTNER_ATTACHMENT_BYTES, signal, cloudflareNetwork(env) || isCloudHosted(env)) }
  catch (error) { fail(502, 'attachment_fetch', `${link.name} could not be fetched: ${refusalText(error, 'no answer')}`) }
  if (!response!.ok) { await response!.body?.cancel(); fail(502, 'attachment_fetch', `${link.name} could not be fetched (HTTP ${response!.status})`) }
  const declared = Number(response!.headers.get('content-length'))
  if (declared > PARTNER_ATTACHMENT_BYTES) { await response!.body?.cancel(); fail(413, 'too_large', `${link.name} is over ${PARTNER_ATTACHMENT_BYTES / 1024 / 1024} MB`) }
  // On a Worker a body of known length streams to storage; otherwise it is read whole, within the limit.
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream
  let body: ReadableStream<Uint8Array> | Uint8Array
  if (Fixed && response!.body && Number.isInteger(declared) && declared > 0) {
    const fixed = new Fixed(declared)
    void response!.body.pipeTo(fixed.writable).catch(() => undefined)
    body = fixed.readable
  }
  else body = await boundedBytes(response!, PARTNER_ATTACHMENT_BYTES).catch(() => fail(413, 'too_large', `${link.name} is over ${PARTNER_ATTACHMENT_BYTES / 1024 / 1024} MB`))
  const size = body instanceof Uint8Array ? body.byteLength : declared
  if (spaceId) await requireStorageQuota(env, spaceId, size)
  const id = newId(), filename = safeName(link.name), key = `${await getServerId(env.DB)}/tasks/${task.id}/${id}-${filename}`, files = fileStorage(env)
  await files.put(key, body)
  const head = await files.get(key, { range: { offset: 0, length: 512 } })
  const first = head ? new Uint8Array(await head.arrayBuffer()) : new Uint8Array()
  const contentType = sniffMime(first, filename) ?? sniffRecordingType(first) ?? 'application/octet-stream'
  const stored = await files.head(key)
  if (!stored || stored.size > PARTNER_ATTACHMENT_BYTES) { await files.delete(key); fail(413, 'too_large', `${link.name} is over the limit`) }
  try {
    await env.DB.prepare("INSERT INTO task_attachments(id,task_id,uploader_id,r2_key,filename,content_type,size_bytes,role,created_at) VALUES(?,?,?,?,?,?,?,'file',?)")
      .bind(id, task.id, auth.principal.id, key, filename, contentType, stored!.size, nowIso()).run()
  }
  catch (error) { await files.delete(key); throw error }
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'task_attachment.create', targetType: 'task', targetId: task.id, meta: { attachmentId: id, filename, partner: true }, authorization: auth })
  await signalTasksChanged(env, task.boardId, task.id).catch(() => undefined)
}

/** The board a Project's new Tasks go on: the first one of its Space, not the Shots board. */
async function projectBoard(env: L4Env, auth: AuthorizationContext, projectId: string) {
  const spaceId = await spaceOfResource(env, 'project', projectId)
  if (!spaceId) fail(404, 'not_found', 'Project not found')
  await ensureFirstBoard(env, spaceId!, auth.principal.id)
  const board = await env.DB.prepare("SELECT id FROM task_boards WHERE space_id=? AND archived_at IS NULL ORDER BY CASE WHEN name='Shots' THEN 1 ELSE 0 END,position,created_at,id LIMIT 1").bind(spaceId).first<{ id: string }>()
  return { boardId: board!.id, spaceId: spaceId! }
}

function taskDescription(body: string, links: string[], attachments: Array<{ name: string }>) {
  const parts = [
    links.length ? `Links:\n${links.map(link => `- ${link}`).join('\n')}` : '',
    attachments.length ? `Attached files:\n${attachments.map(file => `- ${file.name}`).join('\n')}` : '',
  ].filter(Boolean)
  const tail = parts.length ? `\n\n${parts.join('\n\n')}` : ''
  return `${body.trim().slice(0, Math.max(0, 12_000 - tail.length))}${tail}`.trim().slice(0, 12_000)
}

/**
 * A Task for the partner's Agent on the Project's board, with the Project's repository, and its discussion: made
 * at once and answered. Its files are fetched and its Agent started after the answer; if either fails, the Task
 * is marked failed with the reason.
 */
async function createGameTask(env: L4Env, auth: AuthorizationContext, input: z.infer<typeof taskCreateBody>, schedule: Schedule) {
  const project = await readableProject(env, auth, input.projectId)
  const agentId = await partnerAgentId(env, input.agent?.name)
  if (!agentId) fail(409, 'agent_unavailable', input.agent?.name ? `No active Agent is named ${input.agent.name}` : 'This Server has no partner Agent')
  if (input.attachments.length && !mayAttach(auth)) fail(403, 'forbidden', 'Missing attach-files permission')
  const { boardId, spaceId } = await projectBoard(env, auth, project.id)
  const repository = await projectArtifactsRepository(env, project.id)
  const title = input.title.slice(0, 160), description = taskDescription(input.body, input.links, input.attachments)
  const taskId = await insertTask(env, auth, boardId, { title, description, priority: 'normal', dueAt: null, assigneeId: agentId, channelId: null, projectId: project.id,
    ...(repository?.environmentId ? { environmentId: repository.environmentId } : {}), labelIds: [], dependencyIds: [] }, schedule)
  const channelId = await ensureTaskDiscussion(env, auth, taskId)
  const task = { id: taskId, boardId }
  const answer = await taskAnswer(env, (await env.DB.prepare(`SELECT ${taskColumns} FROM tasks WHERE id=?`).bind(taskId).first<TaskRow & { projectId: string }>())!, auth.principal.id)
  schedule((async () => {
    try {
      for (const attachment of input.attachments) await attachFromLink(env, auth, task, spaceId, attachment)
      if (input.build) await applyPartnerConfig(env, project.id, auth.principal.id)
      await createAgentRun(env, auth, { agentId: agentId!, taskId, channelId, prompt: `${input.build ? '' : `${TALK_ONLY}\n\n`}${title}\n\n${description}`, idempotencyKey: `cloud-relay:tasks/create:${input.requestId}` }, undefined, { withoutEnvironment: !input.build })
    }
    catch (error) {
      console.warn('cloud-partner.task_start_failed', { taskId, code: (error as { data?: { error?: { code?: string } } })?.data?.error?.code ?? 'unknown' })
      await markTaskFailed(env, task, refusalText(error, 'The Agent could not be started')).catch(() => undefined)
    }
  })())
  return answer
}

/**
 * What the Member says in the Task's discussion, as from the Task's page, and the assigned Agent hears it as a
 * mention would: a running turn of theirs on this Task takes it in, else a new Run on the Task starts from it,
 * after the answer. A Run that cannot start marks the Task failed with the reason; one that starts reopens it.
 */
async function messageGameTask(env: L4Env, auth: AuthorizationContext, input: z.infer<typeof taskMessageBody>, schedule: Schedule) {
  const task = await readableTask(env, auth, input.taskId)
  const member = await requireMessageMember(env, auth, 'messages:write')
  const channelId = await ensureTaskDiscussion(env, auth, task.id)
  // The Agent is woken below, on the Task; a mention must not start a second, chat-only turn.
  const parts = Array.from({ length: Math.ceil(input.text.length / CHAT_CHARS) }, (_, index) => input.text.slice(index * CHAT_CHARS, (index + 1) * CHAT_CHARS))
  let message: Awaited<ReturnType<typeof sendChannelMessage>>['message'] | undefined
  for (const content of parts) message = (await sendChannelMessage(env, member, channelId, { content }, schedule, undefined, { notifyAgents: false })).message
  const agent = task.assigneeId
    ? await env.DB.prepare("SELECT u.id FROM users u JOIN agents a ON a.user_id=u.id WHERE u.id=? AND u.kind='agent' AND u.status='active' AND a.status='active'").bind(task.assigneeId).first<{ id: string }>()
    : null
  if (agent) schedule(wakeTaskAgent(env, auth, { task, agentId: agent.id, channelId, messageId: message!.id, text: input.text, build: input.build }))
  return { id: message!.id, author: 'member' as const, name: member.user.displayName || null, text: input.text.slice(0, 20_000), createdAt: message!.createdAt }
}

async function wakeTaskAgent(env: L4Env, auth: AuthorizationContext, input: { task: TaskRow; agentId: string; channelId: string; messageId: string; text: string; build: boolean }) {
  try {
    if (env.AGENT_RUN_DO) {
      const active = await env.DB.prepare("SELECT id FROM agent_runs WHERE task_id=? AND agent_id=? AND initiated_by=? AND status='running' ORDER BY created_at DESC LIMIT 1")
        .bind(input.task.id, input.agentId, auth.principal.id).first<{ id: string }>()
      if (active) {
        const run = env.AGENT_RUN_DO.getByName(`run:${active.id}`) as unknown as { steer: (messageId: string, content: string, actorId: string) => Promise<boolean> }
        if (await run.steer(input.messageId, input.text, auth.principal.id)) return
      }
    }
    if (input.build && input.task.projectId) await applyPartnerConfig(env, input.task.projectId, auth.principal.id)
    const run = await createAgentRun(env, auth, { agentId: input.agentId, taskId: input.task.id, channelId: input.channelId, prompt: input.build ? input.text : `${TALK_ONLY}\n\n${input.text}`, sourceMessageId: input.messageId, idempotencyKey: `cloud-relay:${input.messageId}` }, undefined, { withoutEnvironment: !input.build })
    if (run.status !== 'failed' && input.task.status === 'failed') {
      await env.DB.prepare("UPDATE tasks SET status='ready',last_error=NULL,position=?,updated_at=? WHERE id=? AND status='failed'").bind(await firstTaskPosition(env, input.task.boardId, 'ready'), nowIso(), input.task.id).run()
      await signalTasksChanged(env, input.task.boardId, input.task.id).catch(() => undefined)
    }
  }
  catch (error) {
    console.warn('cloud-partner.task_wake_failed', { taskId: input.task.id, code: (error as { data?: { error?: { code?: string } } })?.data?.error?.code ?? 'unknown' })
    await markTaskFailed(env, input.task, refusalText(error, 'The Agent could not be started')).catch(() => undefined)
  }
}

/** The five partner actions; null for any other. The caller has checked the bearer secret and that an Owner exists. */
export async function partnerAction(env: L4Env, action: string, body: unknown, schedule: Schedule): Promise<Answer | null> {
  switch (action) {
    case 'projects/create': {
      const input = projectCreateBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return once(env, action, input.identity, input.requestId, async () => ({ ok: true, project: await createGameProject(env, auth, input.title, input.files) }))
    }
    case 'projects/files': {
      const input = projectFilesBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return { ok: true, files: await projectFiles(env, auth, input) }
    }
    case 'projects/file': {
      const input = projectFileBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return { ok: true, file: await projectFile(env, auth, input) }
    }
    case 'projects/get': {
      const input = projectGetBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return { ok: true, project: await projectAnswer(env, auth, input.projectId) }
    }
    case 'tasks/create': {
      const input = taskCreateBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return once(env, action, input.identity, input.requestId, async () => ({ ok: true, task: await createGameTask(env, auth, input, schedule) }))
    }
    case 'tasks/get': {
      const input = taskGetBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return { ok: true, task: await taskAnswer(env, await readableTask(env, auth, input.taskId), auth.principal.id) }
    }
    case 'tasks/message': {
      const input = taskMessageBody.parse(body)
      const { auth } = await actingMember(env, input.identity)
      return once(env, action, input.identity, input.requestId, async () => ({ ok: true, message: await messageGameTask(env, auth, input, schedule) }))
    }
    default: return null
  }
}
