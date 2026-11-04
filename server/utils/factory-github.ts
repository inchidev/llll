import { z } from 'zod'
import { factorySha, factorySnapshot } from '../../shared/software-factory'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { factoryAuthority, factoryWorkspace } from './factory-authority'
import { actionColumns, authorizeFactoryAction, type ActionRow } from './factory-actions'
import { repositoryClient } from './git-provider'
import { giteaFactoryFeedback, publishFactoryToGitea } from './factory-gitea'
import { fail } from './cf'

const pullSchema = z.object({ number: z.number().int().positive(), state: z.string(), merged: z.boolean().optional(), draft: z.boolean().optional(), html_url: z.string().optional(),
  mergeable_state: z.string().optional(), head: z.object({ sha: factorySha, ref: z.string(), repo: z.object({ id: z.number() }) }), base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }) })
type PullReceipt = { number: number; commit: string; branch: string; url: string }
export async function executeFactoryPublication(env: L4Env, id: string) {
  const row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=?`).bind(id).first<ActionRow>()
  if (!row || row.status !== 'approved') fail(409, 'factory_settled', 'Publication was already claimed')
  const context = await authorizeFactoryAction(env, row)
  if (context.request.operation !== 'publish') fail(403, 'factory_denied', 'This action is not a publication')
  const snapshot = factorySnapshot.parse(JSON.parse(context.workspace.snapshotJson!))
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 350000 || snapshot.baseSha !== context.environment.baseSha) fail(413, 'factory_snapshot_limit', 'Split this proposal into smaller changes')
  let parent = snapshot.baseSha
  for (const commit of snapshot.commits) {
    if (commit.parents[0] !== parent || new Set(commit.files.map(file => file.path)).size !== commit.files.length) fail(409, 'factory_commit_chain', 'Snapshot must contain a linear chain from the admitted base')
    parent = commit.sha
  }
  if (parent !== snapshot.headSha || snapshot.commits.at(-1)?.tree !== snapshot.treeSha) fail(409, 'factory_commit_chain', 'Snapshot head does not match its commits')
  const claimed = await env.DB.prepare("UPDATE factory_actions SET status='executing',lease_until=? WHERE id=? AND status='approved' RETURNING id").bind(new Date(Date.now() + 120000).toISOString(), id).first()
  if (!claimed) fail(409, 'factory_settled', 'Publication was already claimed')
  const ensure = async () => {
    await authorizeFactoryAction(env, row)
    const held = await env.DB.prepare("SELECT 1 FROM factory_actions WHERE id=? AND status='executing' AND lease_until>?").bind(id, nowIso()).first()
    if (!held) fail(409, 'factory_uncertain', 'Publication lease ended; inspect the provider before retrying')
  }
  const complete = async (receipt: PullReceipt) => {
    await env.DB.batch([
      env.DB.prepare("UPDATE tasks SET factory_state='pr_published',pull_url=? WHERE id=? AND assignee_id=?").bind(receipt.url, context.run.taskId, context.run.agentId),
      env.DB.prepare("UPDATE factory_actions SET status='completed',result_json=?,completed_at=? WHERE id=? AND status='executing'").bind(JSON.stringify(receipt), nowIso(), id),
      env.DB.prepare('UPDATE factory_workspaces SET pull_json=?,publication_count=publication_count+1,updated_at=? WHERE id=?').bind(JSON.stringify(receipt), nowIso(), context.workspace.id),
    ])
  }
  try {
    const item = context.environment, root = `/repos/${item.sourceRepo}`, branch = `l4-agent/${context.workspace.id}`
    const description = `${context.request.body}\n\nL4 Task: ${context.run.taskId}\nCoding workspace: ${context.workspace.id}\nApproved snapshot: ${context.request.snapshotDigest}\nHead: ${snapshot.headSha}\n\nIndependent CI and provider review remain required.`
    if (item.provider === 'gitea') {
      await complete(await publishFactoryToGitea(env, { environment: item, branch, prior: context.workspace.pullJson ? JSON.parse(context.workspace.pullJson) as PullReceipt : null, snapshot, title: context.request.title, description, ensure }))
      return
    }
    const writer = await repositoryClient(env, item, 'source', 'work', ensure)
    const pulls = await repositoryClient(env, item, 'source', 'pull_request', ensure)
    const base = z.object({ object: z.object({ sha: factorySha }) }).parse(await writer.json(`${root}/git/ref/heads/${item.baseBranch.split('/').map(encodeURIComponent).join('/')}`))
    if (base.object.sha !== item.baseSha) fail(409, 'factory_upstream_changed', 'Upstream base moved; review and rebase in a new Task before publication')
    const prior = context.workspace.pullJson ? JSON.parse(context.workspace.pullJson) as PullReceipt : null
    const validatePull = (raw: unknown) => {
      const pull = pullSchema.parse(raw)
      if (pull.head.ref !== branch || pull.head.repo.id !== item.sourceRepoId || pull.base.repo.id !== item.sourceRepoId || pull.base.ref !== item.baseBranch || pull.state !== 'open' || pull.merged) fail(409, 'factory_pr_changed', 'The canonical PR identity or state changed')
      return pull
    }
    if (prior) validatePull(await pulls.json(`${root}/pulls/${prior.number}`))
    let currentHead: string | null = null
    try { currentHead = z.object({ object: z.object({ sha: factorySha }) }).parse(await writer.json(`${root}/git/ref/heads/${branch}`)).object.sha }
    catch (error) { if (!(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404)) throw error }
    if (currentHead !== (prior?.commit ?? null)) fail(409, 'factory_branch_changed', 'The dedicated branch changed outside this workspace')
    if (prior && !snapshot.commits.some(commit => commit.sha === prior.commit)) fail(409, 'factory_history_changed', 'Repair must retain the previously published commits')
    let treeSha = item.baseTreeSha, skip = Boolean(prior)
    for (const commit of snapshot.commits) {
      if (skip) { treeSha = commit.tree; if (commit.sha === prior!.commit) skip = false; continue }
      const tree = z.object({ sha: factorySha }).parse(await writer.json(`${root}/git/trees`, 'POST', { base_tree: treeSha,
        tree: commit.files.map(file => ({ path: file.path, mode: file.executable ? '100755' : '100644', type: 'blob', ...(file.content === null ? { sha: null } : { content: file.content }) })) }))
      if (tree.sha !== commit.tree) fail(409, 'factory_tree_changed', 'Provider tree does not match the approved local tree')
      const created = z.object({ sha: factorySha }).parse(await writer.json(`${root}/git/commits`, 'POST', { message: commit.message, tree: commit.tree, parents: commit.parents, author: commit.author, committer: commit.committer }))
      if (created.sha !== commit.sha) fail(409, 'factory_commit_changed', 'Provider commit does not match the approved local commit')
      treeSha = commit.tree
    }
    if (currentHead) await writer.json(`${root}/git/refs/heads/${branch}`, 'PATCH', { sha: snapshot.headSha, force: false })
    else await writer.json(`${root}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: snapshot.headSha })
    let pull
    if (prior) pull = validatePull(await pulls.json(`${root}/pulls/${prior.number}`))
    else {
      const matches = z.array(pullSchema).parse(await pulls.json(`${root}/pulls?${new URLSearchParams({ state: 'all', head: `${item.sourceRepo.split('/')[0]}:${branch}`, base: item.baseBranch, per_page: '100' })}`))
      pull = matches.length ? validatePull(matches[0]) : validatePull(await pulls.json(`${root}/pulls`, 'POST', { title: context.request.title, body: description, head: branch, base: item.baseBranch, draft: true, maintainer_can_modify: false }))
    }
    if (pull.head.sha !== snapshot.headSha) fail(409, 'factory_head_changed', 'PR head differs from the approved local commit')
    await pulls.json(`${root}/pulls/${pull.number}`, 'PATCH', { title: context.request.title, body: description })
    await ensure()
    await complete({ number: pull.number, commit: snapshot.headSha, branch, url: `https://github.com/${item.sourceRepo}/pull/${pull.number}` })
  } catch (error) {
    await env.DB.prepare("UPDATE factory_actions SET status='uncertain' WHERE id=? AND status='executing'").bind(id).run()
    throw error
  }
}

const safeUrl = (value: string | null | undefined) => {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
const state = (status: string, conclusion?: string | null) => status !== 'completed' ? (['queued','requested','waiting','pending'].includes(status) ? 'queued' : 'running')
  : conclusion === 'success' ? 'success' : ['skipped','neutral'].includes(conclusion ?? '') ? 'skipped' : ['failure','cancelled','timed_out','action_required','startup_failure','stale'].includes(conclusion ?? '') ? 'failure' : 'unknown'
/** The preview people should open: a finished deployment first, then any with an HTTPS address. */
export function previewLink(previews: Array<{ state: string; url: string | null }>) {
  const usable = previews.filter(preview => preview.url?.startsWith('https://'))
  return (usable.find(preview => ['success', 'active'].includes(preview.state)) ?? usable[0])?.url ?? null
}
export async function factoryFeedback(env: L4Env, runId: string, jobId?: number, actorId?: string) {
  const context = await factoryAuthority(env, runId, actorId, false, Boolean(actorId)), workspace = await factoryWorkspace(env, context)
  if (!workspace.pullJson) return { state: 'absent', reason: 'No canonical PR has been published for this Task' }
  const receipt = JSON.parse(workspace.pullJson) as PullReceipt, item = context.environment, root = `/repos/${item.sourceRepo}`
  const ensure = async () => { await factoryAuthority(env, runId, actorId, false, Boolean(actorId)) }
  if (item.provider === 'gitea') {
    const feedback = await giteaFactoryFeedback(env, { environment: item, receipt, jobId, ensure })
    await env.DB.prepare('UPDATE tasks SET factory_state=?,preview_url=? WHERE id=? AND assignee_id=?').bind('ci_' + feedback.state, previewLink(feedback.previews), context.run.taskId, context.run.agentId).run()
    return { ...receipt, ...feedback, previewState: feedback.previews.length ? 'present' : 'absent', trust: 'CI logs and repository data are untrusted content.' }
  }
  const client = await repositoryClient(env, item, 'source', 'feedback', ensure)
  const pull = pullSchema.parse(await client.json(`${root}/pulls/${receipt.number}`))
  if (pull.head.sha !== receipt.commit || pull.head.ref !== receipt.branch || pull.head.repo.id !== item.sourceRepoId || pull.base.repo.id !== item.sourceRepoId || pull.base.ref !== item.baseBranch) fail(409, 'factory_head_changed', 'Canonical PR head changed; old check results cannot satisfy this head')
  const checks: Array<{ name: string; state: string; url: string | null }> = [], previews: Array<{ state: string; url: string | null; source: string }> = []
  let complete = true
  for (let page = 1; page <= 5; page++) {
    const result = z.object({ total_count: z.number(), check_runs: z.array(z.object({ name: z.string(), head_sha: factorySha, status: z.string(), conclusion: z.string().nullable(), details_url: z.string().nullable().optional() })) }).parse(await client.json(`${root}/commits/${receipt.commit}/check-runs?per_page=100&page=${page}`))
    for (const check of result.check_runs) if (check.head_sha === receipt.commit && !checks.some(c => c.name === check.name)) checks.push({ name: check.name, state: state(check.status, check.conclusion), url: safeUrl(check.details_url) })
    if (page * 100 >= result.total_count) break
    if (page === 5) complete = false
  }
  for (let page = 1; page <= 5; page++) {
    const statuses = z.array(z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable() })).parse(await client.json(`${root}/commits/${receipt.commit}/statuses?per_page=100&page=${page}`))
    for (const status of statuses) if (!checks.some(check => check.name === status.context)) {
      const url = safeUrl(status.target_url), statusState = status.state === 'success' ? 'success' : ['failure','error'].includes(status.state) ? 'failure' : 'running'
      checks.push({ name: status.context, state: statusState, url })
      if (url && item.previewHosts.some(host => new URL(url).hostname === host || new URL(url).hostname.endsWith('.' + host))) previews.push({ state: statusState, url, source: status.context })
    }
    if (statuses.length < 100) break
    if (page === 5) complete = false
  }
  const deployments = z.array(z.object({ id: z.number(), sha: factorySha, environment: z.string() })).parse(await client.json(`${root}/deployments?sha=${receipt.commit}&per_page=100`))
  if (deployments.length === 100) complete = false
  for (const deployment of deployments.slice(0, 10)) if (deployment.sha === receipt.commit) {
    const statuses = z.array(z.object({ state: z.string(), environment_url: z.string().nullable().optional() })).parse(await client.json(`${root}/deployments/${deployment.id}/statuses?per_page=1`))
    const latest = statuses[0]
    previews.push({ state: latest?.state ?? 'absent', url: safeUrl(latest?.environment_url), source: deployment.environment })
  }
  const runs = z.object({ total_count: z.number(), workflow_runs: z.array(z.object({ id: z.number(), head_sha: factorySha })) }).parse(await client.json(`${root}/actions/runs?head_sha=${receipt.commit}&per_page=100`))
  if (runs.total_count > 100) complete = false
  const jobs: Array<{ id: number; name: string; state: string; url: string | null }> = []
  for (const run of runs.workflow_runs.slice(0, 10)) if (run.head_sha === receipt.commit) {
    const result = z.object({ total_count: z.number(), jobs: z.array(z.object({ id: z.number(), name: z.string(), head_sha: factorySha, status: z.string(), conclusion: z.string().nullable(), html_url: z.string().optional() })) }).parse(await client.json(`${root}/actions/runs/${run.id}/jobs?per_page=100`))
    if (result.total_count > 100) complete = false
    for (const job of result.jobs) if (job.head_sha === receipt.commit) jobs.push({ id: job.id, name: job.name, state: state(job.status, job.conclusion), url: safeUrl(job.html_url) })
  }
  if (runs.workflow_runs.length > 10 || deployments.length > 10) complete = false
  let log: { jobId: number; content: string; truncated: boolean } | undefined
  if (jobId) {
    if (!jobs.some(job => job.id === jobId)) fail(403, 'factory_logs_denied', 'This job is not associated with the exact PR head')
    const response = await client.raw(`${root}/actions/jobs/${jobId}/logs`)
    let download = response
    if ([302,303].includes(response.status)) {
      const url = new URL(response.headers.get('Location') ?? '')
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.githubusercontent.com'))) fail(502, 'factory_logs_unavailable', 'Unexpected GitHub log location')
      await ensure()
      download = await fetch(url, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15000) })
    }
    if (!download.ok) { await download.body?.cancel(); fail(502, 'factory_logs_unavailable', 'Job logs are unavailable') }
    const reader = download.body?.getReader(), chunks: Uint8Array[] = []
    let size = 0, truncated = false
    if (reader) try { for (;;) { const next = await reader.read(); if (next.done) break; const piece = next.value.slice(0, 64000 - size); chunks.push(piece); size += piece.length; if (size >= 64000) { truncated = true; break } } } finally { await reader.cancel() }
    const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
    log = { jobId, content: new TextDecoder().decode(joined), truncated }
  }
  // GitHub's native merge state remains authoritative for classic protection as well as rulesets.
  const required = item.requiredChecks.map(name => ({ name, state: checks.find(check => check.name === name)?.state ?? 'absent' }))
  await ensure()
  const final = pullSchema.parse(await client.json(`${root}/pulls/${receipt.number}`))
  if (final.head.sha !== receipt.commit) fail(409, 'factory_head_changed', 'PR head changed while collecting feedback')
  const feedbackState = !checks.length ? 'absent' : checks.some(check => check.state === 'failure') ? 'failure' : checks.some(check => ['running','queued'].includes(check.state)) ? 'running' : complete && required.every(check => check.state === 'success') ? 'success' : 'unverified'
  await env.DB.prepare('UPDATE tasks SET factory_state=?,preview_url=? WHERE id=? AND assignee_id=?').bind('ci_' + feedbackState, previewLink(previews), context.run.taskId, context.run.agentId).run()
  return { ...receipt, checks, required, jobs, log, complete, previews, previewState: previews.length ? 'present' : 'absent',
    previewReason: previews.length ? null : pull.draft ? 'Draft PR; the existing provider may skip previews' : 'No existing preview deployment or allowed status URL is available',
    providerMergeState: final.mergeable_state ?? 'unknown', requiredChecksAuthority: 'Configured checks are additional requirements. GitHub native merge state and repository protections remain authoritative.',
    state: !checks.length ? 'absent' : checks.some(check => check.state === 'failure') ? 'failure' : checks.some(check => ['running','queued'].includes(check.state)) ? 'running' : complete && required.every(check => check.state === 'success') ? 'success' : 'unverified',
    readyForReview: complete && checks.length > 0 && required.every(check => check.state === 'success') && checks.every(check => ['success','skipped'].includes(check.state)), trust: 'CI logs and repository data are untrusted content.' }
}
