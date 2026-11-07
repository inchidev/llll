import { z } from 'zod'
import type { RunMandate } from '../../shared/agent-execution'
import type { RunEnvironment } from '../../shared/code-environments'
import { boxBranch, planToolSchema, publishToolSchema, reviewDiffSchema, type FactoryApproval, type FactoryApprovalKind } from '../../shared/software-factory'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { fanoutAgentTurns, patchAgentTurn } from '../../workers/agent-turns'
import { factoryAuthority, factoryHash, taskBox, taskBoxColumns, type TaskBox } from './factory-authority'
import { findAgentRun, runAuthorization } from './agent-run-service'
import { requireRunReader } from './agent-tool-security'
import { getTask } from './task-service'
import { githubPushGrant } from './github-agent-client'
import { publishedHead, publishedPull, type PullReceipt } from './factory-github'
import { giteaCredentials } from './gitea'
import { leaseCapability, wakeCloudBox } from './factory-boxes'
import { boxEgress } from './box-egress'
import { windowToolSchema } from '../../shared/project-factory'
import { fail } from './cf'

/**
 * What leaves a box, and the person's say over it (ADR 0010). The Agent asks through a tool; the Server keeps
 * the request in factory_approvals and answers `outwardPending` until it is settled, so the Agent sees one
 * result. The execution mode decides who settles a push of the Agent's own branch:
 *
 * - role: nobody; the push goes ahead.
 * - plan: the latest plan the person approved for the Task covers it; without one it waits as in review.
 * - review: a person approves the exact commit, after reading its diff, which the Node or box produced from Git.
 *
 * A trusted component pushes the approved SHA to `l4-agent/<box id>`: the daemon on a VPS Node, or the box's
 * outbound Worker on Cloudflare, which allows only that ref update. The Server then reads the branch back and
 * opens or updates the Task's draft pull request only if it is at that SHA.
 *
 * `request_network_window` asks for one more host for a while (box-egress.ts). The Project's network is open
 * already; a host outside it always needs a person, unless an approved plan named it in plan mode. Once
 * approved, a window stays open for the Task's box until its time runs out, across the Task's Runs.
 */
export const OUTWARD_TOOLS = new Set(['factory_publish', 'factory_plan', 'request_network_window'])

type ApprovalRow = { id: string; boxId: string; runId: string; callId: string; kind: FactoryApprovalKind; requestJson: string; digest: string; status: string; diffKey: string | null; diffDigest: string | null
  decidedBy: string | null; decidedAt: string | null; expiresAt: string; resultJson: string | null; createdAt: string }
const approvalColumns = `id,box_id AS boxId,run_id AS runId,call_id AS callId,kind,request_json AS requestJson,digest,status,diff_key AS diffKey,diff_digest AS diffDigest,
  decided_by AS decidedBy,decided_at AS decidedAt,expires_at AS expiresAt,result_json AS resultJson,created_at AS createdAt`
/** Statuses in which an approval still holds its Run's turn: the Agent's tool call waits for it. */
export const OPEN_APPROVALS = "('pending_diff','pending','approved','publishing')"
/** A push's review in R2, under the private files bucket. */
export const reviewKey = (boxId: string, approvalId: string) => `factory-reviews/${boxId}/${approvalId}.json`
const publishRequest = publishToolSchema.extend({ ref: z.string() })

const visible = (row: ApprovalRow): FactoryApproval => ({ id: row.id, boxId: row.boxId, runId: row.runId, kind: row.kind, digest: row.digest, status: row.status,
  request: JSON.parse(row.requestJson), diff: row.diffDigest ? { digest: row.diffDigest } : null, decidedBy: row.decidedBy, decidedAt: row.decidedAt,
  expiresAt: row.expiresAt, result: row.resultJson ? JSON.parse(row.resultJson) : null, createdAt: row.createdAt })

export async function expireApprovals(env: L4Env) {
  const now = nowIso()
  await env.DB.batch([
    // An approved plan keeps covering the Task, and an open window stays open for its time; everything else
    // waits no longer than its Run.
    env.DB.prepare("UPDATE factory_approvals SET status='expired' WHERE (status IN ('pending_diff','pending') OR (status='approved' AND kind<>'plan')) AND expires_at<=?").bind(now),
    env.DB.prepare("UPDATE factory_approvals SET status='expired' WHERE (status IN ('pending_diff','pending') OR (status='approved' AND kind NOT IN ('plan','window'))) AND run_id IN (SELECT id FROM agent_runs WHERE status<>'running')"),
    // A push whose Node never said how it went may have happened: a person looks at the branch.
    env.DB.prepare("UPDATE factory_approvals SET status='uncertain' WHERE status='publishing' AND expires_at<=?").bind(now),
  ])
}

/** What the Agent's tool call answers for an approval: its outcome, or that it still waits. */
function answer(row: ApprovalRow) {
  const result = row.resultJson ? JSON.parse(row.resultJson) as Record<string, unknown> : null
  if ((row.kind === 'plan' || row.kind === 'window') && row.status === 'approved') return result ?? { approved: true }
  if (row.status === 'completed' && result) return result
  if (row.status === 'rejected') return { outwardPending: false, approvalId: row.id, status: row.status,
    message: row.kind === 'plan' ? 'The plan was rejected. Ask the person what to change, then propose a revised plan.'
      : row.kind === 'window' ? 'The person did not open this host. Do the work without it, or ask what they would allow.' : 'The person rejected this publication. Ask what to change; do not push the same commit again.' }
  if (row.kind === 'window' && row.status === 'expired' && result) return { ...result, open: false, outwardPending: false, message: 'This window has closed. Ask again if the Task still needs the host.' }
  if (['expired', 'failed', 'uncertain'].includes(row.status)) return { outwardPending: false, approvalId: row.id, status: row.status,
    message: typeof result?.message === 'string' ? result.message : row.status === 'uncertain' ? 'The push may have happened. Ask the person to check the branch before publishing again.' : 'This request did not complete. It will not be repeated.' }
  return { outwardPending: true, approvalId: row.id, status: row.status, reviewUrl: `/runs/${row.runId}` }
}

/** The latest plan for a box counts; proposing a new one pauses what the old one covered until it is decided. */
async function planApproved(env: L4Env, boxId: string) {
  const row = await env.DB.prepare("SELECT status FROM factory_approvals WHERE box_id=? AND kind='plan' ORDER BY created_at DESC,id DESC LIMIT 1").bind(boxId).first<{ status: string }>()
  return row?.status === 'approved'
}

async function setTaskState(env: L4Env, run: { taskId: string | null; agentId: string }, state: string) {
  await env.DB.prepare('UPDATE tasks SET factory_state=? WHERE id=? AND assignee_id=?').bind(state, run.taskId, run.agentId).run()
}
async function showTurn(env: L4Env, run: { id: string; channelId: string; agentId: string }, waiting: boolean) {
  await patchAgentTurn(env, run.id, waiting ? { status: 'waiting_approval', detail: 'Review required' } : { status: 'tool', detail: 'Using a tool' })
  if (env.CHANNEL_DO) await fanoutAgentTurns(env, run.channelId, run.agentId).catch(() => undefined)
}

/**
 * `factory_publish` or `factory_plan`, asked again with the same call until it is settled. The first call
 * records the request; every call answers from the record and never repeats an effect.
 */
export async function outwardToolCall(env: L4Env, runId: string, name: string, callId: string, input: unknown) {
  const isPlan = name === 'factory_plan'
  if (!OUTWARD_TOOLS.has(name)) fail(404, 'tool_unavailable', 'Unknown outward action')
  if (name === 'request_network_window') return windowToolCall(env, runId, callId, input)
  const request = isPlan ? planToolSchema.parse(input) : publishToolSchema.parse(input)
  const context = await factoryAuthority(env, runId, undefined, !isPlan)
  await expireApprovals(env)
  const box = await taskBox(env, context)
  if (!box || box.status === 'released') fail(409, 'box_unavailable', 'This Task has no box. Its first turn makes one.')
  const encoded = JSON.stringify(isPlan ? request : { ...request, ref: boxBranch(box.id) })
  const existing = await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE run_id=? AND call_id=?`).bind(runId, callId).first<ApprovalRow>()
  if (existing) {
    if (existing.requestJson !== encoded) fail(409, 'factory_call_changed', 'A tool call identity cannot change its arguments')
    return answer(existing)
  }
  const execution = (JSON.parse(context.run.mandateJson) as RunMandate).execution
  const mode = execution?.mode ?? 'review'
  if (!isPlan) {
    if (context.environment.sourceRepoId !== context.environment.workRepoId) fail(409, 'factory_fork_unavailable', 'Publication uses a dedicated branch in the original repository')
    if (box.publicationCount >= (execution?.publications ?? 50)) fail(429, 'factory_budget', 'This Task’s publication limit is reached')
    const open = await env.DB.prepare(`SELECT 1 FROM factory_approvals WHERE box_id=? AND kind='publish' AND status IN ${OPEN_APPROVALS} LIMIT 1`).bind(box.id).first()
    if (open) fail(409, 'factory_pending', 'An earlier publication of this Task is still waiting. Wait for it before publishing again.')
  }
  // In role mode a plan is a record, not a gate; a push of the Agent's own branch needs nobody.
  const automatic = mode === 'role' || (!isPlan && mode === 'plan' && await planApproved(env, box.id))
  const status = automatic ? 'approved' : isPlan ? 'pending' : 'pending_diff'
  const id = newId(), now = nowIso(), expiresAt = context.run.deadline
  const digest = await factoryHash(JSON.stringify({ id, boxId: box.id, runId, callId, kind: isPlan ? 'plan' : 'publish', request: encoded, expiresAt }))
  const result = isPlan && automatic ? JSON.stringify({ approved: true, message: 'Plan recorded.' }) : null
  const inserted = await env.DB.prepare(`INSERT INTO factory_approvals(id,box_id,run_id,call_id,kind,request_json,digest,status,decided_at,expires_at,result_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,call_id) DO NOTHING RETURNING ${approvalColumns}`)
    .bind(id, box.id, runId, callId, isPlan ? 'plan' : 'publish', encoded, digest, status, automatic ? now : null, expiresAt, result, now).first<ApprovalRow>()
  const row = inserted ?? await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE run_id=? AND call_id=?`).bind(runId, callId).first<ApprovalRow>()
  if (!row || row.requestJson !== encoded) fail(409, 'factory_call_changed', 'A tool call identity cannot change its arguments')
  if (inserted) {
    if (!isPlan) await setTaskState(env, context.run, automatic ? 'publishing' : 'approval_pending')
    await showTurn(env, context.run, !automatic)
    // A Cloudflare box hears of its push or its review now; a VPS Node on its next sync.
    if (!isPlan) await wakeCloudBox(env, box.id).catch(() => undefined)
  }
  return answer(row)
}

/** An open window: until when, and what the Agent reads about it. */
function openWindow(request: z.infer<typeof windowToolSchema>) {
  const expiresAt = new Date(Date.now() + request.minutes * 60000).toISOString()
  const secrets = request.secrets.map(name => `L4_SECRET_${name}`)
  return { expiresAt, result: { open: true, host: request.host, until: expiresAt, secrets,
    message: `${request.host} is open for this Task until ${expiresAt}.${secrets.length ? ` Send ${secrets.join(', ')} where the value belongs (header, URL or body); the egress layer puts it in on requests to ${request.host}. Never print or store the value.` : ''}` } }
}

/**
 * `request_network_window`: one host for a while, with the Project secrets named for it. The Project's own
 * network needs no window; a host outside it waits for a person, except one an approved plan named in plan
 * mode. Every secret must be a Project secret bound to the host.
 */
async function windowToolCall(env: L4Env, runId: string, callId: string, input: unknown) {
  const request = windowToolSchema.parse(input)
  const context = await factoryAuthority(env, runId)
  await expireApprovals(env)
  const box = await taskBox(env, context)
  if (!box || box.status === 'released') fail(409, 'box_unavailable', 'This Task has no box. Its first turn makes one.')
  const encoded = JSON.stringify(request)
  const existing = await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE run_id=? AND call_id=?`).bind(runId, callId).first<ApprovalRow>()
  if (existing) {
    if (existing.requestJson !== encoded) fail(409, 'factory_call_changed', 'A tool call identity cannot change its arguments')
    return answer(existing)
  }
  const egress = (await boxEgress(env, [box.id])).get(box.id)
  if (!egress?.projectId) fail(409, 'window_unavailable', 'This Task’s repository is not attached to a Project, so its box reaches only this Server. Ask a person to attach the repository to a Project.')
  for (const name of request.secrets) {
    const secret = egress.known.find(entry => entry.name === name)
    if (!secret) fail(400, 'window_secret_unknown', `The Project has no secret named ${name}.${egress.known.length ? ` Its secrets: ${egress.known.map(entry => entry.name).join(', ')}.` : ' Ask a person to add it in the Project’s Secrets.'}`)
    if (!secret.hosts.includes(request.host)) fail(400, 'window_secret_unbound', `${name} is bound to ${secret.hosts.join(', ')}, not ${request.host}. Ask a person to bind it in the Project’s Secrets.`)
  }
  const mode = (JSON.parse(context.run.mandateJson) as RunMandate).execution?.mode ?? 'review'
  const plan = await env.DB.prepare("SELECT status,request_json AS requestJson FROM factory_approvals WHERE box_id=? AND kind='plan' ORDER BY created_at DESC,id DESC LIMIT 1").bind(box.id).first<{ status: string; requestJson: string }>()
  const planned = plan?.status === 'approved' ? JSON.parse(plan.requestJson) as { hosts?: string[]; secrets?: string[] } : null
  const listed = egress.listed.includes(request.host)
  // The Project's network is open already: in role mode, or without a secret, its window needs nobody.
  const automatic = (listed && (mode === 'role' || !request.secrets.length))
    || (mode === 'plan' && Boolean(planned) && (listed || (planned!.hosts ?? []).includes(request.host)) && request.secrets.every(name => (planned!.secrets ?? []).includes(name)))
  const id = newId(), now = nowIso(), opened = automatic ? openWindow(request) : null
  const expiresAt = opened?.expiresAt ?? context.run.deadline
  const digest = await factoryHash(JSON.stringify({ id, boxId: box.id, runId, callId, kind: 'window', request: encoded, expiresAt: context.run.deadline }))
  const inserted = await env.DB.prepare(`INSERT INTO factory_approvals(id,box_id,run_id,call_id,kind,request_json,digest,status,decided_at,expires_at,result_json,created_at)
    VALUES(?,?,?,?,'window',?,?,?,?,?,?,?) ON CONFLICT(run_id,call_id) DO NOTHING RETURNING ${approvalColumns}`)
    .bind(id, box.id, runId, callId, encoded, digest, automatic ? 'approved' : 'pending', automatic ? now : null, expiresAt, opened ? JSON.stringify(opened.result) : null, now).first<ApprovalRow>()
  const row = inserted ?? await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE run_id=? AND call_id=?`).bind(runId, callId).first<ApprovalRow>()
  if (!row || row.requestJson !== encoded) fail(409, 'factory_call_changed', 'A tool call identity cannot change its arguments')
  if (inserted && !automatic) await showTurn(env, context.run, true)
  return answer(row)
}

/** A person's decision on a plan, a push or a window, against the exact digest they reviewed. */
export async function decideApproval(env: L4Env, runId: string, actorId: string, request: { id: string; digest: string; decision: 'approve' | 'reject' }) {
  await expireApprovals(env)
  const row = await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE id=? AND run_id=?`).bind(request.id, runId).first<ApprovalRow>()
  if (!row || row.digest !== request.digest) fail(409, 'factory_changed', 'Review the exact request again')
  const context = await factoryAuthority(env, runId, actorId, row.kind === 'publish')
  if (row.status !== 'pending') return visible(row)
  const approve = request.decision === 'approve'
  // A window's time starts when the person opens it.
  const opened = row.kind === 'window' && approve ? openWindow(windowToolSchema.parse(JSON.parse(row.requestJson))) : null
  const result = row.kind === 'plan' && approve ? JSON.stringify({ approved: true,
    message: 'The person approved this plan. Publications of this Task now go ahead without separate review until you propose a new plan.' }) : opened ? JSON.stringify(opened.result) : null
  const updated = await env.DB.prepare(`UPDATE factory_approvals SET status=?,decided_by=?,decided_at=?,result_json=COALESCE(?,result_json),expires_at=COALESCE(?,expires_at)
    WHERE id=? AND status='pending' AND expires_at>? RETURNING ${approvalColumns}`)
    .bind(approve ? 'approved' : 'rejected', actorId, nowIso(), result, opened?.expiresAt ?? null, row.id, nowIso()).first<ApprovalRow>()
  if (!updated) fail(409, 'factory_settled', 'This request was already decided')
  if (row.kind === 'publish') await setTaskState(env, context.run, approve ? 'publishing' : 'rejected')
  await showTurn(env, context.run, false)
  if (row.kind === 'publish' && approve) await wakeCloudBox(env, row.boxId).catch(() => undefined)
  return visible(updated)
}

/** A person's view of the Task's box and what it asked to send out, newest first. */
export async function listBoxReview(env: L4Env, runId: string, actorId: string) {
  const run = await findAgentRun(env, runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  requireRunReader(run, actorId)
  const auth = await runAuthorization(env, run)
  if (run.taskId) await getTask(env, auth, run.taskId)
  await expireApprovals(env)
  const box = await env.DB.prepare(`SELECT ${taskBoxColumns} FROM factory_boxes WHERE task_id=? AND agent_id=? AND initiated_by=?`).bind(run.taskId, run.agentId, actorId).first<TaskBox>()
  if (!box) return { box: null, approvals: [] }
  if (box.channelId !== run.channelId || box.environmentJson !== run.environmentJson) fail(403, 'factory_revoked', 'This box belongs to an earlier repository mandate')
  const approvals = await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE box_id=? ORDER BY created_at DESC,id DESC LIMIT 50`).bind(box.id).all<ApprovalRow>()
  const environment = JSON.parse(box.environmentJson) as RunEnvironment
  return { box: { id: box.id, status: box.status, nodeId: box.nodeId, repository: environment.sourceRepo, baseBranch: environment.baseBranch, baseSha: environment.baseSha,
    branch: boxBranch(box.id), headSha: box.headSha, runtimeMs: box.runtimeMs, publicationCount: box.publicationCount, updatedAt: box.updatedAt,
    pull: box.pullJson ? JSON.parse(box.pullJson) as PullReceipt : null }, approvals: approvals.results.map(visible) }
}

/** The diff a person reviews, read from R2 for a push of a box the reader may see. */
export async function approvalReview(env: L4Env, runId: string, actorId: string, approvalId: string) {
  const { box, approvals } = await listBoxReview(env, runId, actorId)
  const row = approvals.find(approval => approval.id === approvalId)
  if (!box || !row?.diff) fail(404, 'not_found', 'This request has no review')
  const object = await env.FILES?.get(reviewKey(box.id, row.id))
  if (!object) fail(404, 'not_found', 'The review is no longer stored')
  const text = await object.text()
  if (await factoryHash(text) !== row.diff.digest) fail(409, 'factory_changed', 'The stored review differs from the one approved')
  return reviewDiffSchema.parse(JSON.parse(text))
}

type Publication = { row: ApprovalRow; box: TaskBox & { leaseUntil: string | null }; request: z.infer<typeof publishRequest>; environment: RunEnvironment }
/** A push of a box held by this Node under a live lease, in one of these statuses. */
async function nodePublication(env: L4Env, nodeId: string, approvalId: string, statuses: string[]): Promise<Publication> {
  const row = await env.DB.prepare(`SELECT ${approvalColumns} FROM factory_approvals WHERE id=? AND kind='publish'`).bind(approvalId).first<ApprovalRow>()
  const box = row ? await env.DB.prepare(`SELECT ${taskBoxColumns},lease_until AS leaseUntil FROM factory_boxes WHERE id=? AND node_id=?`).bind(row.boxId, nodeId).first<TaskBox & { leaseUntil: string | null }>() : null
  if (!row || !box || !statuses.includes(row.status) || !box.leaseToken || !box.leaseUntil || box.leaseUntil <= nowIso() || row.expiresAt <= nowIso()) fail(403, 'factory_publication_denied', 'This publication is not this Node’s to work on now')
  return { row, box, request: publishRequest.parse(JSON.parse(row.requestJson)), environment: JSON.parse(box.environmentJson) as RunEnvironment }
}

/**
 * The review of a push, as its Node or box produced it from Git: the commits and diff from the pinned base to
 * the requested SHA. It goes to R2 and only its key and digest to D1; the approval's digest then covers the
 * diff, so a person approves the commit they read. A review that could not be made fails the request.
 */
export async function submitReview(env: L4Env, nodeId: string, approvalId: string, bytes: Uint8Array) {
  const { row, request, environment } = await nodePublication(env, nodeId, approvalId, ['pending_diff'])
  let parsed: { ok: true; review: z.infer<typeof reviewDiffSchema> } | { ok: false; message: string }
  try { parsed = z.union([z.object({ ok: z.literal(true), review: reviewDiffSchema }).strict(), z.object({ ok: z.literal(false), message: z.string().max(500) }).strict()]).parse(JSON.parse(new TextDecoder().decode(bytes))) }
  catch { fail(400, 'factory_review_invalid', 'Invalid review') }
  if (!parsed.ok || parsed.review.sha !== request.sha || parsed.review.baseSha !== environment.baseSha) {
    const message = parsed.ok ? 'The review does not match the requested commit' : `The commit could not be reviewed: ${parsed.message}`
    await env.DB.prepare("UPDATE factory_approvals SET status='failed',result_json=? WHERE id=? AND status='pending_diff'").bind(JSON.stringify({ message }), row.id).run()
    return { accepted: false }
  }
  if (!env.FILES) fail(503, 'files_unavailable', 'File storage is unavailable')
  const text = JSON.stringify(parsed.review), diffDigest = await factoryHash(text), key = reviewKey(row.boxId, row.id)
  await env.FILES.put(key, text, { httpMetadata: { contentType: 'application/json' } })
  const digest = await factoryHash(JSON.stringify({ request: row.digest, diff: diffDigest }))
  const updated = await env.DB.prepare("UPDATE factory_approvals SET status='pending',diff_key=?,diff_digest=?,digest=? WHERE id=? AND status='pending_diff' RETURNING id").bind(key, diffDigest, digest, row.id).first()
  return { accepted: Boolean(updated) }
}

/**
 * Takes an approved push for its Node or box, once: what to push, where, and the branch head it must replace
 * (the one this Task published last, or none). A branch that moved outside L4 stops the publication.
 */
export async function claimPublication(env: L4Env, nodeId: string, approvalId: string) {
  const publication = await nodePublication(env, nodeId, approvalId, ['approved'])
  const { row, box, request, environment } = publication
  const prior = box.pullJson ? JSON.parse(box.pullJson) as PullReceipt : null
  const ensure = async () => { await nodePublication(env, nodeId, approvalId, ['approved', 'publishing']) }
  const current = await publishedHead(env, environment, request.ref, ensure)
  if (current !== (prior?.commit ?? null)) {
    await env.DB.prepare("UPDATE factory_approvals SET status='failed',result_json=? WHERE id=? AND status='approved'")
      .bind(JSON.stringify({ message: `The branch ${request.ref} changed outside L4. Ask the person to look at it before publishing again.` }), row.id).run()
    fail(409, 'factory_branch_changed', 'The dedicated branch changed outside this Task')
  }
  const claimed = await env.DB.prepare("UPDATE factory_approvals SET status='publishing' WHERE id=? AND status='approved' RETURNING id").bind(row.id).first()
  if (!claimed) fail(409, 'factory_settled', 'This publication was already claimed')
  return { ...publication, ref: `refs/heads/${request.ref}`, expectedOld: current, ensure: async () => { await nodePublication(env, nodeId, approvalId, ['publishing']) } }
}

/**
 * A VPS Node's push grant: GitHub gives its daemon a single-repository contents write token for this push,
 * which it revokes afterwards; a Gitea push goes through this Server, with a capability bound to the approval
 * and the box's lease, and the Server allows only the approved ref update.
 */
export async function computePublish(env: L4Env, nodeId: string, approvalId: string) {
  const { box, request, environment, ref, expectedOld, ensure } = await claimPublication(env, nodeId, approvalId)
  const pinned = { approvalId, repository: environment.sourceRepo, ref, sha: request.sha, baseSha: environment.baseSha, expectedOld }
  if (environment.provider === 'gitea') {
    await giteaCredentials(env, environment.gitConnectionId)
    let origin: string
    try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'compute_publish', 'Configure this Server’s public origin before publishing to Gitea') }
    return { ...pinned, remote: `${origin}/api/compute-agent/publish/${approvalId}.git`, authorization: `Bearer ${await leaseCapability(env, 'compute-publish', approvalId, box.leaseToken!)}` }
  }
  const token = await githubPushGrant(env, { connectionId: environment.gitConnectionId, installationId: environment.sourceInstallationId, repositoryId: environment.sourceRepoId }, ensure)
  return { ...pinned, remote: `https://github.com/${environment.sourceRepo}.git`, token }
}

/**
 * The push is done, or failed. The Server reads the branch back: only at exactly the approved SHA does it open
 * or update the draft pull request and count the publication. Anything else leaves the approval uncertain.
 */
export async function publishedApproval(env: L4Env, nodeId: string, approvalId: string, outcome: { ok: boolean; message?: string }) {
  const { row, box, request, environment } = await nodePublication(env, nodeId, approvalId, ['publishing'])
  const run = await findAgentRun(env, row.runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  if (!outcome.ok) {
    await env.DB.prepare("UPDATE factory_approvals SET status='failed',result_json=? WHERE id=? AND status='publishing'")
      .bind(JSON.stringify({ message: `The push was refused or failed${outcome.message ? `: ${outcome.message.slice(0, 300)}` : ''}. Nothing was published.` }), row.id).run()
    await setTaskState(env, run, 'publish_failed')
    return { accepted: true }
  }
  const prior = box.pullJson ? JSON.parse(box.pullJson) as PullReceipt : null
  const description = `${request.body}\n\nL4 Task: ${run.taskId}\nBox: ${box.id}\nApproved commit: ${request.sha}\n\nIndependent CI and provider review remain required.`
  let receipt: PullReceipt
  try {
    receipt = await publishedPull(env, environment, { branch: request.ref, sha: request.sha, prior, title: request.title, description,
      ensure: async () => { await nodePublication(env, nodeId, approvalId, ['publishing']) } })
  } catch (error) {
    await env.DB.prepare("UPDATE factory_approvals SET status='uncertain',result_json=? WHERE id=? AND status='publishing'")
      .bind(JSON.stringify({ message: 'The push finished, but the branch or its pull request could not be confirmed. Ask the person to look at the branch before publishing again.' }), row.id).run()
    throw error
  }
  const result = { published: true, sha: request.sha, branch: request.ref, pull: receipt }
  await env.DB.batch([
    env.DB.prepare("UPDATE factory_approvals SET status='completed',result_json=? WHERE id=? AND status='publishing'").bind(JSON.stringify(result), row.id),
    env.DB.prepare('UPDATE factory_boxes SET pull_json=?,publication_count=publication_count+1,updated_at=? WHERE id=?').bind(JSON.stringify(receipt), nowIso(), box.id),
    env.DB.prepare("UPDATE tasks SET factory_state='pr_published',pull_url=? WHERE id=? AND assignee_id=?").bind(receipt.url, run.taskId, run.agentId),
  ])
  return { accepted: true }
}

/** What a sync tells a leased box to do for its pushes: make the review of one, or push one that was approved. */
export async function boxOutwardWork(env: L4Env, boxIds: string[]) {
  const work = new Map<string, { review?: { approvalId: string; sha: string; baseSha: string }; publish?: { approvalId: string; sha: string; ref: string; baseSha: string } }>()
  if (!boxIds.length) return work
  const rows = await env.DB.prepare(`SELECT a.id,a.box_id AS boxId,a.status,a.request_json AS requestJson,json_extract(b.environment_json,'$.baseSha') AS baseSha FROM factory_approvals a JOIN factory_boxes b ON b.id=a.box_id
    WHERE a.box_id IN (SELECT value FROM json_each(?)) AND a.kind='publish' AND a.status IN ('pending_diff','approved') AND a.expires_at>? ORDER BY a.created_at,a.id`)
    .bind(JSON.stringify(boxIds), nowIso()).all<{ id: string; boxId: string; status: string; requestJson: string; baseSha: string }>()
  for (const row of rows.results) {
    const request = publishRequest.parse(JSON.parse(row.requestJson)), entry = work.get(row.boxId) ?? {}
    if (row.status === 'pending_diff') entry.review ??= { approvalId: row.id, sha: request.sha, baseSha: row.baseSha }
    else entry.publish ??= { approvalId: row.id, sha: request.sha, ref: `refs/heads/${request.ref}`, baseSha: row.baseSha }
    work.set(row.boxId, entry)
  }
  return work
}
