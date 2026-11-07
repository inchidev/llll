import { z } from 'zod'
import type { AuthorizationContext } from '../../shared/authorization'
import type { RunEnvironment } from '../../shared/code-environments'
import { newId, nowIso } from '../../shared/ids'
import { Permission } from '../../shared/permissions'
import { projectPermissionAllowed } from '../../shared/project-access'
import type { ProjectGitFlow } from '../../shared/project-factory'
import { factorySha, mergeRequestSchema, mergeToolSchema } from '../../shared/software-factory'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { factoryAuthority, factoryHash, taskBox, taskBoxColumns, type TaskBox } from './factory-authority'
import { pullFeedback, type PullReceipt } from './factory-github'
import { githubAgentClient } from './github-agent-client'
import { giteaAgentClient } from './gitea'
import { giteaPull } from './gitea-proposal'
import { publishTarget, repositoryGitFlow } from './project-git-flow'
import { requireTask, taskPermissionAllowed } from './task-policy'
import { fail } from './cf'

/**
 * The merge of a Task's pull request from L4 (ADR 0010), the end of the Factory. A person merges from the Task
 * under the `person` and `agent_after_checks` Git flows; the Agent merges with `factory_merge` only under
 * `agent_after_checks`. Both wait for the readiness `factory_feedback` reports: every check of the approved head
 * passed, and there was at least one. A person may also merge a head for which the provider reports no checks,
 * no statuses and no Actions jobs at all, so that a repository without CI can be merged from L4; the answer
 * says so. The Agent never merges unchecked code. The provider merges exactly that head (`sha`), so a head that moved is refused, with
 * the Project's merge method. The provider's branch protection stays the ceiling: a merge it refuses is
 * reported with its reason and never retried around it.
 *
 * Every attempt is a factory_approvals row of kind `merge`, completed or failed, for the audit. A merged pull
 * request marks the Task's code work Merged on the board; the Task's own status is left to the people and
 * the existing Task rules.
 */
const githubPull = z.object({ number: z.number().int().positive(), state: z.string(), merged: z.boolean().optional(), draft: z.boolean().optional(), node_id: z.string().optional(),
  head: z.object({ sha: factorySha, ref: z.string(), repo: z.object({ id: z.number() }) }), base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }) })
type MergeBy = { kind: 'person'; id: string } | { kind: 'agent'; runId: string; callId: string }
type Outcome = { status: 'completed' | 'failed' | 'uncertain'; result: Record<string, unknown> }
const MERGE_WINDOW_MS = 10 * 60000

/** The Task's box whose pull request is the Task's: the one that published last. */
async function taskPullBox(env: L4Env, taskId: string) {
  return env.DB.prepare(`SELECT ${taskBoxColumns},origin_run_id AS originRunId FROM factory_boxes WHERE task_id=? AND (pull_json IS NOT NULL OR pushed_sha IS NOT NULL)
    ORDER BY updated_at DESC,id DESC LIMIT 1`).bind(taskId).first<TaskBox & { originRunId: string }>()
}

type Feedback = { state?: string; complete?: boolean; readyForReview?: boolean; checks?: unknown[]; jobs?: unknown[]; required?: Array<{ name: string; state: string }> }
export const NO_CHECKS_REASON = 'No checks or statuses were reported for this head, so nothing has tested it. Merge only if that is what you want.'

/**
 * True when the provider reported nothing at all for the head: no check, no commit status, no Actions job, and
 * the repository environment names no required check. Only a person may merge such a head.
 */
export function noChecksReported(feedback: Feedback) {
  return feedback.complete === true && !feedback.checks?.length && !feedback.jobs?.length && !feedback.required?.length
}

/**
 * Why a pull request cannot be merged yet, from its feedback, or null once every check of its head passed. For a
 * person, also null when no checks were reported at all; any check or status that exists must still pass.
 */
export function mergeBlocker(feedback: Feedback, by: MergeBy['kind'] = 'agent') {
  if (feedback.readyForReview) return null
  if (by === 'person' && noChecksReported(feedback)) return null
  const missing = (feedback.required ?? []).filter(check => check.state !== 'success').map(check => check.name)
  if (feedback.state === 'failure') return 'A check of the pull request’s head failed.'
  if (feedback.state === 'running') return 'Checks of the pull request’s head are still running.'
  if (feedback.state === 'absent') return 'No checks have run on the pull request’s head yet.'
  return missing.length ? `Required checks have not passed: ${missing.join(', ')}.` : 'Not every check of the pull request’s head passed.'
}

/** What the provider said when it refused, on one line: its message, never more than 300 characters. */
async function providerReason(response: Response) {
  const body = await readLimitedStream(response.body, 16000).catch(() => ({ ok: false as const }))
  let reason = `HTTP ${response.status}`
  if (body.ok) {
    const text = new TextDecoder().decode(body.bytes)
    try {
      const parsed = JSON.parse(text) as { message?: unknown; errors?: Array<{ message?: unknown } | string> }
      const extra = (parsed.errors ?? []).map(entry => typeof entry === 'string' ? entry : entry?.message).filter((entry): entry is string => typeof entry === 'string')
      if (typeof parsed.message === 'string' && parsed.message) reason = [parsed.message, ...extra].join(' ')
    } catch { if (text.trim()) reason = text }
  }
  return reason.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 300)
}

/**
 * Asks the provider to merge exactly `receipt.commit` with `method`. A draft is made ready first: GitHub
 * refuses to merge a draft, and Gitea a WIP title. Nothing here is retried.
 */
async function providerMerge(env: L4Env, item: RunEnvironment, receipt: PullReceipt, method: ProjectGitFlow['method'], ensure: () => Promise<void>): Promise<Outcome> {
  const root = `/repos/${item.sourceRepo}`, sha = receipt.commit
  const same = (pull: { state: string; merged?: boolean; head: { sha: string; ref: string; repo: { id: number } }; base: { ref: string; repo: { id: number } } }) => {
    if (pull.merged) fail(409, 'merge_done', `Pull request #${receipt.number} is merged already`)
    if (pull.state !== 'open') fail(409, 'merge_closed', `Pull request #${receipt.number} is closed`)
    if (pull.head.sha !== sha) fail(409, 'merge_head_moved', `Pull request #${receipt.number} moved to ${pull.head.sha}; only the approved head ${sha} can be merged`)
    if (pull.head.ref !== receipt.branch || pull.head.repo.id !== item.sourceRepoId || pull.base.repo.id !== item.sourceRepoId || pull.base.ref !== item.baseBranch) fail(409, 'factory_pr_changed', 'The pull request’s identity changed')
  }
  if (item.provider === 'gitea') {
    const client = await giteaAgentClient(env, { connectionId: item.gitConnectionId, repository: item.sourceRepo, access: 'merge' }, ensure)
    const pull = giteaPull.parse(await client.json(`${root}/pulls/${receipt.number}`))
    same(pull)
    const title = pull.title ?? ''
    if (/^(?:WIP:|\[WIP\])\s*/iu.test(title)) await client.json(`${root}/pulls/${receipt.number}`, 'PATCH', { title: title.replace(/^(?:WIP:|\[WIP\])\s*/iu, '') || title })
    let response: Response
    try { response = await client.raw(`${root}/pulls/${receipt.number}/merge`, 'POST', { Do: method, head_commit_id: sha, delete_branch_after_merge: false }) }
    catch { return { status: 'uncertain', result: { message: 'Gitea did not answer the merge. Look at the pull request before merging again.' } } }
    if (!response.ok) return { status: 'failed', result: { message: `Gitea refused the merge: ${await providerReason(response)}` } }
    await response.body?.cancel()
    const merged = giteaPull.extend({ merge_commit_sha: factorySha.nullable().optional() }).parse(await client.json(`${root}/pulls/${receipt.number}`))
    return merged.merged ? { status: 'completed', result: { sha: merged.merge_commit_sha ?? null } } : { status: 'uncertain', result: { message: 'Gitea accepted the merge, but the pull request is not merged yet. Look at it before merging again.' } }
  }
  const client = await githubAgentClient(env, { connectionId: item.gitConnectionId, installationId: item.sourceInstallationId, repositoryId: item.sourceRepoId, access: 'merge' }, ensure)
  const pull = githubPull.parse(await client.json(`${root}/pulls/${receipt.number}`))
  same(pull)
  if (pull.draft) {
    if (!pull.node_id) fail(502, 'github_response', 'GitHub did not identify the pull request')
    await client.markReadyForReview(pull.node_id)
  }
  let response: Response
  try { response = await client.raw(`${root}/pulls/${receipt.number}/merge`, 'PUT', { sha, merge_method: method }) }
  catch { return { status: 'uncertain', result: { message: 'GitHub did not answer the merge. Look at the pull request before merging again.' } } }
  if (!response.ok) return { status: 'failed', result: { message: `GitHub refused the merge: ${await providerReason(response)}` } }
  const body = await readLimitedStream(response.body, 64000)
  const merged = body.ok ? z.object({ sha: factorySha.nullable().optional(), merged: z.boolean() }).safeParse(JSON.parse(new TextDecoder().decode(body.bytes))) : null
  return merged?.success && merged.data.merged ? { status: 'completed', result: { sha: merged.data.sha ?? null } }
    : { status: 'uncertain', result: { message: 'GitHub answered the merge without confirming it. Look at the pull request before merging again.' } }
}

type MergeInput = { box: TaskBox & { originRunId?: string }; runId: string; callId: string; environment: RunEnvironment; gitFlow: ProjectGitFlow; sha: string; by: MergeBy; ensure: () => Promise<void> }
type MergeRow = { id: string; status: string; resultJson: string | null; requestJson: string }

/** One merge attempt, recorded before the provider is asked and settled with what it answered. */
async function mergePull(env: L4Env, input: MergeInput) {
  const { box, environment, gitFlow, sha, by } = input
  if (gitFlow.merge === 'direct_push') fail(409, 'merge_unavailable', `This Project’s Git flow pushes straight to ${environment.baseBranch}; there is no pull request to merge.`)
  if (!box.pullJson) fail(409, 'merge_unavailable', 'This Task has no pull request yet')
  const receipt = JSON.parse(box.pullJson) as PullReceipt
  if (receipt.merged) fail(409, 'merge_done', `Pull request #${receipt.number} was merged from L4 already`)
  if (receipt.commit !== sha) fail(409, 'merge_head_moved', `The pull request’s approved head is ${receipt.commit}, not ${sha}. Read its checks again.`)
  // The same readiness factory_feedback reports, read now at exactly the approved head.
  const feedback = await pullFeedback(env, environment, receipt, undefined, input.ensure)
  const blocker = mergeBlocker(feedback, by.kind)
  if (blocker) fail(409, 'merge_not_ready', `${blocker} The pull request can be merged from L4 once every check of its head passed.`)
  const unchecked = !feedback.readyForReview
  const id = newId(), now = nowIso(), request = JSON.stringify({ sha, number: receipt.number, method: gitFlow.method, by: by.kind, ...(unchecked ? { checks: 'none' } : {}) })
  const digest = await factoryHash(JSON.stringify({ id, boxId: box.id, runId: input.runId, callId: input.callId, kind: 'merge', request }))
  const inserted = await env.DB.prepare(`INSERT INTO factory_approvals(id,box_id,run_id,call_id,kind,request_json,digest,status,decided_by,decided_at,expires_at,created_at)
    VALUES(?,?,?,?,'merge',?,?,'publishing',?,?,?,?) ON CONFLICT(run_id,call_id) DO NOTHING RETURNING id`)
    .bind(id, box.id, input.runId, input.callId, request, digest, by.kind === 'person' ? by.id : null, now, new Date(Date.now() + MERGE_WINDOW_MS).toISOString(), now).first()
  if (!inserted) fail(409, 'factory_settled', 'This merge was already asked for')
  let outcome: Outcome
  try { outcome = await providerMerge(env, environment, receipt, gitFlow.method, input.ensure) }
  catch (error) {
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message.slice(0, 300) : 'The merge could not be asked for'
    await env.DB.prepare("UPDATE factory_approvals SET status='failed',result_json=? WHERE id=? AND status='publishing'").bind(JSON.stringify({ message: `Not merged: ${message}` }), id).run()
    throw error
  }
  const result = outcome.status === 'completed'
    ? { merged: true, sha: outcome.result.sha, number: receipt.number, url: receipt.url, method: gitFlow.method, message: `Merged pull request #${receipt.number} into ${environment.baseBranch} (${gitFlow.method}).${unchecked ? ' No checks were reported for its head.' : ''}`, ...(unchecked ? { unchecked: true } : {}) }
    : outcome.result
  const statements = [env.DB.prepare('UPDATE factory_approvals SET status=?,result_json=? WHERE id=? AND status=\'publishing\'').bind(outcome.status, JSON.stringify(result), id)]
  if (outcome.status === 'completed') {
    const merged: PullReceipt = { ...receipt, merged: { sha: (outcome.result.sha as string | null) ?? null, method: gitFlow.method, at: nowIso(), by: by.kind } }
    statements.push(env.DB.prepare('UPDATE factory_boxes SET pull_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(merged), nowIso(), box.id),
      env.DB.prepare("UPDATE tasks SET factory_state='merged' WHERE id=?").bind(box.taskId))
  } else if (outcome.status === 'failed') statements.push(env.DB.prepare("UPDATE tasks SET factory_state='merge_failed' WHERE id=?").bind(box.taskId))
  await env.DB.batch(statements)
  return { id, status: outcome.status, result }
}

/** A person may merge from the Task where they may approve Agent actions in the repository's Project. */
function mayMerge(auth: AuthorizationContext, task: { projectId?: string | null; boardId: string }, projectId: string | null) {
  if (auth.principal.kind !== 'human' || auth.credential.kind !== 'session') return false
  return projectId ? projectPermissionAllowed(auth, projectId, Permission.approveAgentActions) : taskPermissionAllowed(auth, task, Permission.approveAgentActions)
}

/** What the Task shows about its code: the Git flow, the pull request or pushed commit, and whether it can be merged now. */
export async function taskMergeState(env: L4Env, auth: AuthorizationContext, taskId: string) {
  const task = await requireTask(env, taskId, auth)
  const box = await taskPullBox(env, task.id)
  if (!box) return { box: null, gitFlow: null, canMerge: false, ready: false, unchecked: false, reason: null }
  const environment = JSON.parse(box.environmentJson) as RunEnvironment
  const { projectId, gitFlow } = await repositoryGitFlow(env, environment.id)
  const pull = box.pullJson ? JSON.parse(box.pullJson) as PullReceipt : null
  const canMerge = mayMerge(auth, task, projectId) && gitFlow.merge !== 'direct_push'
  let ready = false, unchecked = false, reason: string | null
  if (!pull) reason = gitFlow.merge === 'direct_push' ? null : 'No pull request yet.'
  else if (pull.merged) reason = 'Merged.'
  else if (gitFlow.merge === 'direct_push') reason = `This Project’s Git flow now pushes straight to ${environment.baseBranch}; merge this pull request in ${environment.provider === 'gitea' ? 'Gitea' : 'GitHub'}.`
  else {
    try {
      const feedback = await pullFeedback(env, environment, pull, undefined, async () => {})
      reason = mergeBlocker(feedback, 'person'); ready = !reason
      if (ready && !feedback.readyForReview) { unchecked = true; reason = NO_CHECKS_REASON }
    }
    catch (error) { reason = `The checks could not be read: ${error && typeof error === 'object' && 'message' in error ? String(error.message).slice(0, 200) : 'unknown error'}` }
  }
  return { box: { id: box.id, repository: environment.sourceRepo, baseBranch: environment.baseBranch, branch: publishTarget(gitFlow, box.id, environment).ref, pushedSha: box.pushedSha, pull },
    gitFlow, canMerge, ready, unchecked, reason }
}

/** `POST /api/tasks/:id/merge`: a person merges the Task's pull request at the head they saw. */
export async function personMerge(env: L4Env, auth: AuthorizationContext, taskId: string, request: unknown) {
  const { sha } = mergeRequestSchema.parse(request)
  const task = await requireTask(env, taskId, auth)
  const box = await taskPullBox(env, task.id)
  if (!box?.pullJson) fail(409, 'merge_unavailable', 'This Task has no pull request yet')
  const environment = JSON.parse(box.environmentJson) as RunEnvironment
  const { projectId, gitFlow } = await repositoryGitFlow(env, environment.id)
  if (!mayMerge(auth, task, projectId)) fail(403, 'merge_denied', 'Approve agent actions in this project is required to merge')
  if (task.environmentId !== environment.id) fail(409, 'factory_revoked', 'The Task’s repository changed since this pull request was published')
  const ensure = async () => {
    const current = await env.DB.prepare('SELECT pull_json AS pullJson FROM factory_boxes WHERE id=?').bind(box.id).first<{ pullJson: string | null }>()
    const receipt = current?.pullJson ? JSON.parse(current.pullJson) as PullReceipt : null
    if (receipt?.commit !== sha || receipt.merged) fail(409, 'merge_head_moved', 'The pull request changed while it was being merged')
  }
  const merged = await mergePull(env, { box, runId: box.runId ?? box.originRunId, callId: `merge:${newId()}`, environment, gitFlow, sha, by: { kind: 'person', id: auth.principal.id }, ensure })
  if (merged.status !== 'completed') fail(merged.status === 'failed' ? 409 : 502, merged.status === 'failed' ? 'merge_refused' : 'merge_uncertain', String(merged.result.message ?? 'Not merged'))
  return { ...await taskMergeState(env, auth, task.id), message: String(merged.result.message) }
}

/**
 * `factory_merge`: the Agent merges its Task's pull request, offered only where the Project's Git flow is
 * `agent_after_checks`. Asked again with the same call, it answers from its record and never merges twice.
 */
export async function mergeToolCall(env: L4Env, runId: string, callId: string, input: unknown) {
  const { sha } = mergeToolSchema.parse(input)
  const existing = await env.DB.prepare("SELECT id,status,result_json AS resultJson,request_json AS requestJson FROM factory_approvals WHERE run_id=? AND call_id=? AND kind='merge'").bind(runId, callId).first<MergeRow>()
  if (existing) {
    if ((JSON.parse(existing.requestJson) as { sha: string }).sha !== sha) fail(409, 'factory_call_changed', 'A tool call identity cannot change its arguments')
    return { ...(existing.resultJson ? JSON.parse(existing.resultJson) : {}), outwardPending: existing.status === 'publishing', approvalId: existing.id, status: existing.status }
  }
  const context = await factoryAuthority(env, runId, undefined, true)
  const box = await taskBox(env, context)
  if (!box) fail(409, 'box_unavailable', 'This Task has no box. Its first turn makes one.')
  const { gitFlow } = await repositoryGitFlow(env, context.environment.id)
  if (gitFlow.merge !== 'agent_after_checks') fail(403, 'merge_denied', gitFlow.merge === 'direct_push' ? 'This Project pushes straight to its base branch; there is nothing to merge.' : 'In this Project a person merges. Tell them the pull request is ready.')
  const ensure = async () => {
    await factoryAuthority(env, runId, undefined, true)
    const current = await env.DB.prepare('SELECT pull_json AS pullJson FROM factory_boxes WHERE id=?').bind(box.id).first<{ pullJson: string | null }>()
    if ((current?.pullJson ? JSON.parse(current.pullJson) as PullReceipt : null)?.commit !== sha) fail(409, 'merge_head_moved', 'The pull request changed while it was being merged')
  }
  const merged = await mergePull(env, { box, runId, callId, environment: context.environment, gitFlow, sha, by: { kind: 'agent', runId, callId }, ensure })
  return { ...merged.result, outwardPending: false, approvalId: merged.id, status: merged.status }
}
