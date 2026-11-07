import { z } from 'zod'
import type { RunEnvironment } from '../../shared/code-environments'
import type { L4Env } from '../../workers/env'
import { pullPath, repositoryClient } from './git-provider'
import { giteaDraftTitle, giteaFindPull, giteaPull } from './gitea-proposal'
import { fail } from './cf'

type PullReceipt = { number: number; commit: string; branch: string; url: string }
/** The Gitea half of a publication: the branch was pushed and checked; open or update its pull request. */
export async function giteaPublishedPull(env: L4Env, item: RunEnvironment, input: { branch: string; sha: string; prior: PullReceipt | null; title: string; description: string; ensure: () => Promise<void> }) {
  const { branch, prior, ensure } = input
  const pulls = await repositoryClient(env, item, 'source', 'pull_request', ensure)
  const validatePull = (raw: unknown) => {
    const pull = giteaPull.parse(raw)
    if (pull.head.ref !== branch || pull.head.repo.id !== item.sourceRepoId || pull.base.repo.id !== item.sourceRepoId || pull.base.ref !== item.baseBranch || pull.state !== 'open' || pull.merged) fail(409, 'factory_pr_changed', 'The canonical PR identity or state changed')
    return pull
  }
  let pull
  if (prior) pull = validatePull(await pulls.json(`/repos/${item.sourceRepo}/pulls/${prior.number}`))
  else {
    const match = await giteaFindPull(pulls, item.sourceRepo, candidate => candidate.head.ref === branch && candidate.head.repo.id === item.sourceRepoId && candidate.base.ref === item.baseBranch)
    pull = validatePull(match ?? await pulls.json(`/repos/${item.sourceRepo}/pulls`, 'POST', { title: giteaDraftTitle(input.title), body: input.description, head: branch, base: item.baseBranch }))
  }
  if (pull.head.sha !== input.sha) fail(409, 'factory_head_changed', 'PR head differs from the approved commit')
  await pulls.json(`/repos/${item.sourceRepo}/pulls/${pull.number}`, 'PATCH', { title: giteaDraftTitle(input.title), body: input.description })
  await ensure()
  return { number: pull.number, commit: input.sha, branch, url: pulls.web(pullPath('gitea', pull.number)) } satisfies PullReceipt
}

const safeUrl = (value: string | null | undefined) => {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
const status = z.object({ context: z.string(), status: z.string().optional(), state: z.string().optional(), target_url: z.string().nullable().optional() })
/** Gitea reports CI as commit statuses (Gitea Actions writes one per job). Job logs stay in Gitea. */
export async function giteaFactoryFeedback(env: L4Env, input: { environment: RunEnvironment; receipt: PullReceipt; jobId?: number; ensure: () => Promise<void> }) {
  const { environment: item, receipt, ensure } = input
  const client = await repositoryClient(env, item, 'source', 'feedback', ensure)
  const root = `/repos/${item.sourceRepo}`
  const pull = giteaPull.parse(await client.json(`${root}/pulls/${receipt.number}`))
  if (pull.head.sha !== receipt.commit || pull.head.ref !== receipt.branch || pull.head.repo.id !== item.sourceRepoId || pull.base.repo.id !== item.sourceRepoId || pull.base.ref !== item.baseBranch) fail(409, 'factory_head_changed', 'Canonical PR head changed; old check results cannot satisfy this head')
  if (input.jobId) fail(404, 'factory_logs_unavailable', 'Job logs are not available from Gitea; open the pull request in Gitea to read them')
  const checks: Array<{ name: string; state: string; url: string | null }> = [], previews: Array<{ state: string; url: string | null; source: string }> = []
  let complete = true
  for (let page = 1; page <= 5; page++) {
    // Newest first: the first status for a context is its current state.
    const statuses = z.array(status).parse(await client.json(`${root}/commits/${receipt.commit}/statuses?limit=50&page=${page}&sort=recentupdate`))
    for (const entry of statuses) if (!checks.some(check => check.name === entry.context)) {
      const value = entry.status ?? entry.state ?? 'pending', url = safeUrl(entry.target_url)
      const state = value === 'success' ? 'success' : ['failure', 'error'].includes(value) ? 'failure' : value === 'warning' ? 'unknown' : 'running'
      checks.push({ name: entry.context, state, url })
      if (url && item.previewHosts.some(host => new URL(url).hostname === host || new URL(url).hostname.endsWith('.' + host))) previews.push({ state, url, source: entry.context })
    }
    if (statuses.length < 50) break
    if (page === 5) complete = false
  }
  const required = item.requiredChecks.map(name => ({ name, state: checks.find(check => check.name === name)?.state ?? 'absent' }))
  await ensure()
  const final = giteaPull.parse(await client.json(`${root}/pulls/${receipt.number}`))
  if (final.head.sha !== receipt.commit) fail(409, 'factory_head_changed', 'PR head changed while collecting feedback')
  const state = !checks.length ? 'absent' : checks.some(check => check.state === 'failure') ? 'failure' : checks.some(check => check.state === 'running') ? 'running' : complete && required.every(check => check.state === 'success') ? 'success' : 'unverified'
  return { checks, required, jobs: [] as Array<{ id: number; name: string; state: string; url: string | null }>, log: undefined, complete, previews, state,
    previewReason: previews.length ? null : 'No allowed status URL is available', providerMergeState: final.mergeable === undefined ? 'unknown' : final.mergeable ? 'clean' : 'blocked',
    requiredChecksAuthority: 'Configured checks are additional requirements. Gitea branch protection and its merge checks remain authoritative.',
    readyForReview: complete && checks.length > 0 && required.every(check => check.state === 'success') && checks.every(check => check.state === 'success') }
}
