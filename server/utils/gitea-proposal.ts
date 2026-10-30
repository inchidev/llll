import { z } from 'zod'
import type { CodeProposalInput, RunEnvironment } from '../../shared/code-environments'
import type { L4Env } from '../../workers/env'
import { pullPath, repositoryClient, type RepositoryClient } from './git-provider'
import { fail } from './cf'

const sha = z.string().regex(/^[a-f0-9]{40}$/u)
export const giteaPull = z.object({ number: z.number().int().positive(), state: z.string(), merged: z.boolean().optional(), title: z.string().optional(), body: z.string().nullable().optional(),
  mergeable: z.boolean().optional(), draft: z.boolean().optional(), html_url: z.string().optional(),
  head: z.object({ ref: z.string(), sha, repo: z.object({ id: z.number() }) }), base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }) })
export type GiteaPull = z.infer<typeof giteaPull>
const reference = z.object({ ref: z.string(), object: z.object({ sha }) })
/** Gitea has no draft flag on create; a WIP title marks the pull request as work in progress and blocks merging. */
export const giteaDraftTitle = (title: string) => `WIP: ${title}`

const notFound = (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404)
/** Gitea answers a ref lookup with every ref under that prefix; only the exact branch counts. */
export async function giteaBranchHead(client: RepositoryClient, repo: string, branch: string) {
  let value: unknown
  try { value = await client.json(`/repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`) }
  catch (error) { if (notFound(error)) return null; throw error }
  const refs = z.array(reference).parse(Array.isArray(value) ? value : [value])
  return refs.find(ref => ref.ref === `refs/heads/${branch}`)?.object.sha ?? null
}
export async function giteaCreateBranch(client: RepositoryClient, repo: string, branch: string, commit: string) {
  await client.json(`/repos/${repo}/branches`, 'POST', { new_branch_name: branch, old_ref_name: commit })
}
const base64 = (text: string) => { let binary = ''; for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte); return btoa(binary) }
type FileChange = { path: string; content: string | null; executable: boolean }
/** Builds one Gitea change-files request against the branch's current files. File modes cannot be set
 * through Gitea's API: a new executable is refused, and an existing file keeps its mode. */
export async function giteaFileOperations(client: RepositoryClient, repo: string, branch: string, files: FileChange[], allowExecutable = false) {
  if (!allowExecutable && files.some(file => file.executable && file.content !== null)) fail(400, 'gitea_executable', 'Gitea cannot mark files executable through its API. Propose the file without the executable flag; existing files keep their mode.')
  const operations: Array<{ operation: 'create' | 'update' | 'delete'; path: string; content?: string; sha?: string }> = []
  for (const file of files) {
    let existing: string | null = null
    try { existing = z.object({ type: z.string(), sha }).parse(await client.json(`/repos/${repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`)).sha }
    catch (error) { if (!notFound(error)) throw error }
    if (file.content === null) { if (existing) operations.push({ operation: 'delete', path: file.path, sha: existing }); continue }
    operations.push(existing ? { operation: 'update', path: file.path, content: base64(file.content), sha: existing } : { operation: 'create', path: file.path, content: base64(file.content) })
  }
  return operations
}
export const giteaCommitResponse = z.object({ commit: z.object({ sha, tree: z.object({ sha }).optional(), parents: z.array(z.object({ sha })).optional() }) })

/** Finds the pull request for one branch. Gitea cannot filter pull requests by head, so this pages through them. */
export async function giteaFindPull(client: RepositoryClient, repo: string, match: (pull: GiteaPull) => boolean) {
  for (let page = 1; page <= 10; page++) {
    const pulls = z.array(giteaPull).parse(await client.json(`/repos/${repo}/pulls?state=all&limit=50&page=${page}`))
    const found = pulls.find(match)
    if (found) return found
    if (pulls.length < 50) return null
  }
  fail(409, 'gitea_pulls_limit', 'Too many pull requests to find this branch safely; close stale ones or start a new attempt')
}

type Input = { runId: string; environment: RunEnvironment; input: CodeProposalInput; description: string; branch: string
  proposal: { commitSha: string | null; publishedCommitSha: string | null; pullNumber: number | null }; ensure: () => Promise<void>; recordCommit: (sha: string) => Promise<void> }
/** All writes target the Run's own branch. Gitea writes a commit onto a branch, so the branch starts at the admitted base. */
export async function publishGiteaProposal(env: L4Env, { runId, environment: item, input, description, branch, proposal, ensure, recordCommit }: Input) {
  const work = await repositoryClient(env, item, 'work', 'work', ensure)
  const target = await repositoryClient(env, item, 'source', 'pull_request', ensure)
  const title = giteaDraftTitle(input.title)
  const validatePull = (value: unknown) => {
    const pr = giteaPull.parse(value)
    if (pr.head.repo.id !== item.workRepoId || pr.base.repo.id !== item.sourceRepoId || pr.head.ref !== branch || pr.base.ref !== item.baseBranch) fail(409, 'proposal_mismatch', 'Pull request identity changed')
    if (pr.state !== 'open' || pr.merged) fail(409, 'proposal_closed', 'This pull request is closed; start a new reviewed task attempt')
    return pr
  }
  if (proposal.pullNumber) validatePull(await target.json(`/repos/${item.sourceRepo}/pulls/${proposal.pullNumber}`))
  let head = await giteaBranchHead(work, item.workRepo, branch)
  let commit = proposal.commitSha
  if (!commit) {
    const parent = proposal.publishedCommitSha ?? item.baseSha
    if (!head) {
      if (proposal.publishedCommitSha) fail(409, 'proposal_deleted', 'The working branch was deleted')
      await giteaCreateBranch(work, item.workRepo, branch, item.baseSha)
      head = await giteaBranchHead(work, item.workRepo, branch)
    }
    if (head !== parent) fail(409, 'proposal_changed', 'The working branch changed outside this Run')
    const files = await giteaFileOperations(work, item.workRepo, branch, input.files)
    if (!files.length) fail(400, 'proposal_empty', 'This proposal changes no files')
    const created = giteaCommitResponse.parse(await work.json(`/repos/${item.workRepo}/contents`, 'POST', { branch, message: `${input.title.replace(/[\r\n]/gu, ' ')}\n\nL4-Run: ${runId}`, files }))
    if (created.commit.parents && created.commit.parents[0]?.sha !== parent) fail(409, 'proposal_changed', 'The working branch changed while this proposal was written')
    commit = created.commit.sha
    await recordCommit(commit)
  } else if (head !== commit) fail(409, 'proposal_changed', 'The working branch changed outside this Run')
  const owner = item.workRepo.split('/')[0]!
  let pr: GiteaPull
  if (proposal.pullNumber) pr = validatePull(await target.json(`/repos/${item.sourceRepo}/pulls/${proposal.pullNumber}`))
  else {
    const existing = await giteaFindPull(target, item.sourceRepo, pull => pull.head.ref === branch && pull.head.repo.id === item.workRepoId && pull.base.ref === item.baseBranch)
    pr = validatePull(existing ?? await target.json(`/repos/${item.sourceRepo}/pulls`, 'POST', {
      title, body: description, head: item.workRepoId === item.sourceRepoId ? branch : `${owner}:${branch}`, base: item.baseBranch }))
  }
  if (pr.title !== title || (pr.body ?? '') !== description) await target.json(`/repos/${item.sourceRepo}/pulls/${pr.number}`, 'PATCH', { title, body: description })
  return { number: pr.number, url: target.web(pullPath('gitea', pr.number)), commit }
}
