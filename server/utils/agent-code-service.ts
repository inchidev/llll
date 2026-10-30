import { fileStorage } from '../../shared/file-storage'
import { z } from 'zod'
import { codeProposalSchema, type RunEnvironment } from '../../shared/code-environments'
import { authorize, ServerAction } from '../../shared/authorization'
import type { RunMandate } from '../../shared/agent-execution'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { findAgentRun, runAuthorization } from './agent-run-service'
import { pullPath, repositoryClient } from './git-provider'
import { publishGiteaProposal } from './gitea-proposal'
import { requireRunEnvironment } from './code-environment-service'
import { getTask } from './task-service'
import { fail } from './cf'
import { writeAudit } from './messages'
import { readLimitedStream } from '../../workers/inbound-email-signature'

export async function codeRepositoryArchive(env: L4Env, runId: string): Promise<Response> {
  const { environment: item } = await codeRun(env, runId)
  const key = item.provider === 'gitea' ? `agent-repositories/gitea/${item.gitConnectionId}/${item.sourceRepoId}/${item.baseSha}.tar.gz` : `agent-repositories/${item.sourceRepoId}/${item.baseSha}.tar.gz`
  // Revalidate the dedicated App grant even when private code is already cached.
  const client = await repositoryClient(env, item, 'source', 'read', async () => { await codeRun(env, runId) })
  const cached = await fileStorage(env).get(key)
  if (cached && cached.size <= 20000000) {
    await codeRun(env, runId)
    return new Response(cached.body, { headers: { 'Content-Type': 'application/gzip' } })
  }
  // Gitea serves the archive itself, with the repository name as its top-level directory.
  if (client.provider === 'gitea') {
    const archive = await client.raw(`/repos/${item.sourceRepo}/archive/${item.baseSha}.tar.gz`)
    if (!archive.ok) { await archive.body?.cancel(); fail(502, 'code_archive', 'Gitea repository archive is unavailable') }
    return storeArchive(env, runId, key, archive)
  }
  const redirected = await client.raw(`/repos/${item.sourceRepo}/tarball/${item.baseSha}`)
  if (![302, 303].includes(redirected.status)) fail(502, 'code_archive', 'GitHub repository archive is unavailable')
  let location: URL
  try { location = new URL(redirected.headers.get('Location') || '') }
  catch { fail(502, 'code_archive', 'GitHub returned an unexpected archive location') }
  if (location.origin !== 'https://codeload.github.com' || location.username || location.password || location.hash
    || location.pathname.toLowerCase() !== `/${item.sourceRepo.toLowerCase()}/legacy.tar.gz/${item.baseSha}`) fail(502, 'code_archive', 'GitHub returned an unexpected archive location')
  // Signed redirect only. Never forward the App credential to another host.
  await codeRun(env, runId)
  const downloaded = await fetch(location, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30000) })
  if (!downloaded.ok) {
    await downloaded.body?.cancel()
    fail(502, 'code_archive', 'GitHub repository archive is unavailable')
  }
  return storeArchive(env, runId, key, downloaded)
}
async function storeArchive(env: L4Env, runId: string, key: string, downloaded: Response) {
  const body = await readLimitedStream(downloaded.body, 20000000)
  if (!body.ok) fail(413, 'code_archive', 'Repository archive exceeds the execution limit or is unavailable')
  await codeRun(env, runId)
  await fileStorage(env).put(key, body.bytes, { httpMetadata: { contentType: 'application/gzip' } })
  await codeRun(env, runId)
  return new Response(new Uint8Array(body.bytes), { headers: { 'Content-Type': 'application/gzip' } })
}

const sha = z.string().regex(/^[a-f0-9]{40}$/u)
const ref = z.object({ object: z.object({ sha }) })
const gitCommit = z.object({ sha, tree: z.object({ sha }) })
const pull = z.object({ number: z.number().int().positive(), state: z.string(), merged: z.boolean().optional(),
  title: z.string().optional(), body: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha, repo: z.object({ id: z.number() }) }), base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }) })
const safePath = z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.includes('\\') && ![...value].some(character => character.charCodeAt(0) < 32)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git'), 'Invalid repository path')
export const readCodeSchema = z.object({ path: safePath })

export async function codeRun(env: L4Env, id: string, write = false) {
  const run = await findAgentRun(env, id)
  if (!run || run.status !== 'running' || run.deadline <= nowIso() || !run.taskId || !run.environmentJson || !(JSON.parse(run.mandateJson) as RunMandate).computer) fail(403, 'code_denied', 'Code access needs an active task-backed computer mandate')
  const auth = await runAuthorization(env, run)
  authorize(auth, ServerAction.useComputer)
  if (write) authorize(auth, ServerAction.proposeCode)
  const task = await getTask(env, auth, run.taskId)
  if (!task || task.assigneeId !== run.agentId) fail(403, 'code_revoked', 'Task is no longer assigned to this agent')
  const environment = await requireRunEnvironment(env, auth, JSON.parse(run.environmentJson) as RunEnvironment)
  if (task.environmentId && task.environmentId !== environment.id) fail(403, 'code_revoked', 'Task repository changed')
  return { run, auth, environment }
}
export async function readCodeTree(env: L4Env, runId: string) {
  const { environment: item } = await codeRun(env, runId)
  const client = await repositoryClient(env, item, 'source', 'read', async () => { await codeRun(env, runId) })
  const tree = z.object({ truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })).nullable().transform(value => value ?? []) })
    .parse(await client.json(`/repos/${item.sourceRepo}/git/trees/${item.baseTreeSha}?${client.provider === 'gitea' ? 'recursive=true&per_page=5000' : 'recursive=1'}`))
  return { repository: item.sourceRepo, commit: item.baseSha, truncated: tree.truncated || tree.tree.length > 5000, files: tree.tree.slice(0, 5000) }
}
export async function readCodeFile(env: L4Env, runId: string, path: string) {
  safePath.parse(path)
  const { environment: item } = await codeRun(env, runId)
  const client = await repositoryClient(env, item, 'source', 'read', async () => { await codeRun(env, runId) })
  const file = z.object({ type: z.literal('file'), encoding: z.literal('base64'), size: z.number().max(100000), content: z.string().max(150000) })
    .parse(await client.json(`/repos/${item.sourceRepo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${item.baseSha}`))
  let content
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(file.content.replace(/\s/gu, '')), character => character.charCodeAt(0))) }
  catch { fail(400, 'binary_file', 'Use text source files for this code proposal') }
  return { repository: item.sourceRepo, commit: item.baseSha, path, content }
}

type Proposal = { inputHash: string; branch: string; commitSha: string | null; publishedCommitSha: string | null; pullNumber: number | null; status: string }
const proposalColumns = 'input_hash as inputHash,branch,commit_sha as commitSha,published_commit_sha as publishedCommitSha,pull_number as pullNumber,status'

/** All writes target a Run-owned branch in the repository or its configured fork. This broker has no merge or release operation. */
export async function publishCodeProposal(env: L4Env, runId: string, request: z.input<typeof codeProposalSchema>) {
  const input = codeProposalSchema.parse(request)
  const { run, environment: item, auth } = await codeRun(env, runId, true)
  const description = `${input.body}\n\nL4 task: ${run.taskId}\nL4 Run: ${runId}\n\nAgent reports require independent CI and human review.`
  const encoded = JSON.stringify({ ...input, files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)) })
  const inputHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), value => value.toString(16).padStart(2, '0')).join('')
  const branch = `l4-agent/${runId}`
  await env.DB.prepare('INSERT INTO agent_code_proposals(run_id,environment_id,input_hash,branch,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
    .bind(runId, item.id, inputHash, branch, nowIso(), nowIso()).run()
  let proposal = (await env.DB.prepare(`SELECT ${proposalColumns} FROM agent_code_proposals WHERE run_id=?`).bind(runId).first<Proposal>())!
  if (proposal.inputHash !== inputHash) {
    const next = await env.DB.prepare("UPDATE agent_code_proposals SET input_hash=?,commit_sha=NULL,status='pending',updated_at=? WHERE run_id=? AND input_hash=? AND status='published' AND lease_token IS NULL RETURNING run_id")
      .bind(inputHash, nowIso(), runId, proposal.inputHash).first()
    if (!next) fail(409, 'proposal_uncertain', 'Review or finish the previous proposal before changing it')
  }
  const lease = newId()
  const claimed = await env.DB.prepare("UPDATE agent_code_proposals SET lease_token=?,lease_until=?,status='working',updated_at=? WHERE run_id=? AND input_hash=? AND (lease_token IS NULL OR lease_until<=?) RETURNING run_id")
    .bind(lease, new Date(Date.now() + 300000).toISOString(), nowIso(), runId, inputHash, nowIso()).first()
  if (!claimed) fail(409, 'proposal_busy', 'A code proposal is already being published')
  const ensure = async () => {
    await codeRun(env, runId, true)
    const held = await env.DB.prepare('SELECT 1 FROM agent_code_proposals WHERE run_id=? AND lease_token=? AND lease_until>?').bind(runId, lease, nowIso()).first()
    if (!held) fail(409, 'proposal_lease', 'Proposal publication was interrupted; review its current state')
  }
  try {
    proposal = (await env.DB.prepare(`SELECT ${proposalColumns} FROM agent_code_proposals WHERE run_id=?`).bind(runId).first<Proposal>())!
    if (item.provider === 'gitea') {
      const published = await publishGiteaProposal(env, { runId, environment: item, input, description, branch, proposal, ensure,
        recordCommit: async commitSha => { await env.DB.prepare('UPDATE agent_code_proposals SET commit_sha=?,updated_at=? WHERE run_id=? AND lease_token=?').bind(commitSha, nowIso(), runId, lease).run() } })
      await env.DB.prepare("UPDATE agent_code_proposals SET pull_number=?,published_commit_sha=commit_sha,status='published',lease_until=NULL,lease_token=NULL,updated_at=? WHERE run_id=? AND lease_token=?")
        .bind(published.number, nowIso(), runId, lease).run()
      await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'agent.code.propose', targetType: 'run', targetId: runId,
        meta: { provider: 'gitea', repository: item.sourceRepo, workingFork: item.workRepo, pull: published.number, commit: published.commit }, authorization: auth })
      return { url: published.url, number: published.number, commit: published.commit, status: 'draft', checks: 'unverified' }
    }
    const work = await repositoryClient(env, item, 'work', 'work', ensure)
    const target = await repositoryClient(env, item, 'source', 'pull_request', ensure)
    const validatePull = (value: unknown) => {
      const pr = pull.parse(value)
      if (pr.head.repo.id !== item.workRepoId || pr.base.repo.id !== item.sourceRepoId || pr.head.ref !== branch || pr.base.ref !== item.baseBranch) fail(409, 'proposal_mismatch', 'Pull request identity changed')
      if (pr.state !== 'open' || pr.merged) fail(409, 'proposal_closed', 'This pull request is closed; start a new reviewed task attempt')
      return pr
    }
    if (proposal.pullNumber) validatePull(await target.json(`/repos/${item.sourceRepo}/pulls/${proposal.pullNumber}`))
    if (!proposal.commitSha) {
      const base = proposal.publishedCommitSha
        ? gitCommit.parse(await work.json(`/repos/${item.workRepo}/git/commits/${proposal.publishedCommitSha}`))
        : { sha: item.baseSha, tree: { sha: item.baseTreeSha } }
      const tree = z.object({ sha }).parse(await work.json(`/repos/${item.workRepo}/git/trees`, 'POST', { base_tree: base.tree.sha,
        tree: input.files.map(file => ({ path: file.path, mode: file.executable ? '100755' : '100644', type: 'blob', ...(file.content === null ? { sha: null } : { content: file.content }) })) }))
      const commit = z.object({ sha }).parse(await work.json(`/repos/${item.workRepo}/git/commits`, 'POST', {
        message: `${input.title.replace(/[\r\n]/gu, ' ')}\n\nL4-Run: ${runId}`, tree: tree.sha, parents: [base.sha],
      }))
      await env.DB.prepare('UPDATE agent_code_proposals SET commit_sha=?,updated_at=? WHERE run_id=? AND lease_token=?').bind(commit.sha, nowIso(), runId, lease).run()
      proposal.commitSha = commit.sha
    }
    let current: z.infer<typeof ref> | null = null
    try { current = ref.parse(await work.json(`/repos/${item.workRepo}/git/ref/heads/${branch}`)) }
    catch (error) { if (!(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404)) throw error }
    if (current && current.object.sha !== proposal.commitSha) {
      if (current.object.sha !== proposal.publishedCommitSha) fail(409, 'proposal_changed', 'The working branch changed outside this Run')
      await work.json(`/repos/${item.workRepo}/git/refs/heads/${branch}`, 'PATCH', { sha: proposal.commitSha, force: false })
    } else if (!current) {
      if (proposal.publishedCommitSha) fail(409, 'proposal_deleted', 'The working branch was deleted')
      await work.json(`/repos/${item.workRepo}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: proposal.commitSha })
    }
    const owner = item.workRepo.split('/')[0]!
    let pr: z.infer<typeof pull>
    if (proposal.pullNumber) pr = validatePull(await target.json(`/repos/${item.sourceRepo}/pulls/${proposal.pullNumber}`))
    else {
      const existing = z.array(pull).parse(await target.json(`/repos/${item.sourceRepo}/pulls?${new URLSearchParams({ state: 'all', head: item.workRepoId === item.sourceRepoId ? branch : `${owner}:${branch}`, base: item.baseBranch })}`))
      pr = existing.length ? validatePull(existing[0]) : validatePull(await target.json(`/repos/${item.sourceRepo}/pulls`, 'POST', {
        title: input.title, body: description,
        head: item.workRepoId === item.sourceRepoId ? branch : `${owner}:${branch}`, head_repo: item.workRepo.split('/')[1], base: item.baseBranch, draft: true, maintainer_can_modify: false,
      }))
    }
    if (pr.title !== input.title || pr.body !== description) await target.json(`/repos/${item.sourceRepo}/pulls/${pr.number}`, 'PATCH', {
      title: input.title, body: description,
    })
    await env.DB.prepare("UPDATE agent_code_proposals SET pull_number=?,published_commit_sha=commit_sha,status='published',lease_until=NULL,lease_token=NULL,updated_at=? WHERE run_id=? AND lease_token=?")
      .bind(pr.number, nowIso(), runId, lease).run()
    await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'agent.code.propose', targetType: 'run', targetId: runId,
      meta: { repository: item.sourceRepo, workingFork: item.workRepo, pull: pr.number, commit: proposal.commitSha }, authorization: auth })
    return { url: `https://github.com/${item.sourceRepo}/pull/${pr.number}`, number: pr.number, commit: proposal.commitSha, status: 'draft', checks: 'unverified' }
  } catch (error) {
    await env.DB.prepare("UPDATE agent_code_proposals SET status='pending',lease_token=NULL,lease_until=NULL,updated_at=? WHERE run_id=? AND lease_token=?").bind(nowIso(), runId, lease).run()
    throw error
  }
}

export async function codeProposalChecks(env: L4Env, runId: string) {
  const { environment: item } = await codeRun(env, runId)
  const proposal = await env.DB.prepare(`SELECT ${proposalColumns} FROM agent_code_proposals WHERE run_id=?`).bind(runId).first<Proposal>()
  if (!proposal?.pullNumber || !proposal.publishedCommitSha) fail(404, 'not_found', 'Published code proposal not found')
  const client = await repositoryClient(env, item, 'source', 'checks', async () => { await codeRun(env, runId) })
  const pr = pull.parse(await client.json(`/repos/${item.sourceRepo}/pulls/${proposal.pullNumber}`))
  if (pr.head.repo.id !== item.workRepoId || pr.head.ref !== proposal.branch || pr.base.repo.id !== item.sourceRepoId || pr.base.ref !== item.baseBranch) fail(409, 'proposal_changed', 'Pull request identity changed')
  if (pr.head.sha !== proposal.publishedCommitSha) fail(409, 'proposal_changed', 'Pull request head changed; verify the new commit separately')
  // Gitea has commit statuses only; Gitea Actions reports each job as one. Its status field is `status`.
  const checks = client.provider === 'gitea' ? { total_count: 0, check_runs: [] } : z.object({ total_count: z.number(), check_runs: z.array(z.object({ name: z.string(), head_sha: sha, status: z.string(), conclusion: z.string().nullable(), details_url: z.string().nullable().optional() })) })
    .parse(await client.json(`/repos/${item.sourceRepo}/commits/${proposal.publishedCommitSha}/check-runs?per_page=100`))
  const statuses = z.object({ statuses: z.array(z.object({ context: z.string(), state: z.string().optional(), status: z.string().optional(), target_url: z.string().nullable().optional() })
    .transform(status => ({ context: status.context, state: status.state ?? status.status ?? 'pending', target_url: status.target_url || null }))).nullable().transform(value => value ?? []) })
    .parse(await client.json(`/repos/${item.sourceRepo}/commits/${proposal.publishedCommitSha}/status?${client.provider === 'gitea' ? 'limit=50' : 'per_page=100'}`))
  const actual = new Map<string, string>()
  for (const check of checks.check_runs) if (check.head_sha === proposal.publishedCommitSha && !actual.has(check.name)) actual.set(check.name, check.status === 'completed' ? check.conclusion ?? 'unknown' : 'pending')
  for (const status of statuses.statuses) if (!actual.has(status.context)) actual.set(status.context, status.state)
  const required = item.requiredChecks.map(name => ({ name, status: actual.get(name) ?? 'missing' }))
  const previews = statuses.statuses.filter(status => status.state === 'success' && status.target_url).map(status => status.target_url!).filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && item.previewHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) } catch { return false }
  })
  return { url: client.web(pullPath(client.provider, pr.number)), commit: proposal.publishedCommitSha,
    readyForReview: checks.total_count <= 100 && required.every(check => check.status === 'success'), required, previews, state: pr.state }
}
