import { z } from 'zod'
import type { AuthorizationContext } from '../../shared/authorization'
import { artifactsRepositoryName, type RunEnvironment } from '../../shared/code-environments'
import { inspectReceivePack, type ExpectedPush } from '../../shared/git-pktline'
import { newId, nowIso } from '../../shared/ids'
import { Permission } from '../../shared/permissions'
import { projectPermissionAllowed } from '../../shared/project-access'
import type { ProjectGitFlow } from '../../shared/project-factory'
import { serverRuntime } from '../../shared/server-runtime'
import { ARTIFACTS_UNAVAILABLE, projectReleaseSchema, projectRepositoryName, releaseTag, type ProjectRelease } from '../../shared/software-factory'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { saveCodeEnvironment } from './code-environment-service'
import type { PullReceipt } from './factory-github'
import { advertisedRefs, blob, commit, objectId, pushRefs, tag, tree, ZERO_SHA, type GitIdentity, type GitObject } from './git-pack'
import { writeAudit } from './messages'
import { addProjectRepository, requireProject } from './project-service'
import { enabledCompute, requireConnectAuthority } from './repository-connect'
import { spaceOfResource } from './space-access'
import { parseBody } from './validate'

/**
 * Artifacts as a Git provider (ADR 0013): one repository per Project inside the Server's own namespace, the one
 * `FACTORY_CODE` is bound to, so a Project owns its code without any GitHub or Gitea account. A Task's box
 * pushes to `<prefix><box id>` as it does elsewhere; there is no pull request, and review happens in L4. The
 * repository's tokens are repository-wide, so L4 itself keeps the branch rule (the egress layer allows one ref
 * update per push) and does the merge: the Server builds the merge commit and pushes it with a token of its own
 * that never reaches a box. Versions are annotated tags on the base branch, made from the Project.
 *
 * The binding is the connection: there is no row in git_connections. The provider exists only where the binding
 * does, on a Server in the operator's own Cloudflare account with Compute enabled; celld and hosted Servers say so.
 */
type Artifacts = NonNullable<L4Env['FACTORY_CODE']>
type Repository = Awaited<ReturnType<Artifacts['get']>>
const SHA = /^[a-f0-9]{40}$/u

export type ArtifactsAvailability = { available: true; reason: null } | { available: false; reason: string }
export function artifactsAvailability(env: L4Env): ArtifactsAvailability {
  const runtime = serverRuntime(env)
  if (runtime !== 'cloudflare') return { available: false, reason: ARTIFACTS_UNAVAILABLE[runtime] }
  if (!env.FACTORY_CODE) return { available: false, reason: ARTIFACTS_UNAVAILABLE.compute }
  return { available: true, reason: null }
}
export function requireArtifacts(env: L4Env): Artifacts {
  const availability = artifactsAvailability(env)
  if (!availability.available) fail(409, 'artifacts_unavailable', availability.reason)
  return env.FACTORY_CODE!
}
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message.replace(/\p{Cc}+/gu, ' ').slice(0, 300) : fallback

/** A repository handle; a repository just created may answer `CREATE_IN_PROGRESS` for a moment. */
async function repository(code: Artifacts, name: string): Promise<Repository> {
  for (let attempt = 0; ; attempt++) {
    try { return await code.get(name) }
    catch (error) {
      if (attempt >= 5 || errorCode(error) !== 'CREATE_IN_PROGRESS') throw error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
}
/** One repository handle for `fn`, disposed afterwards. */
export async function withRepository<T>(env: L4Env, name: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
  const repo = await repository(requireArtifacts(env), name)
  try { return await fn(repo) } finally { repo[Symbol.dispose]() }
}

export type ArtifactsGrant = { remote: string; token: string; revoke: () => Promise<void> }
/**
 * A short token for one repository and one scope, for a trusted component's Git transport: the box's outbound
 * Worker, a Node's transport through this Server or the Server's own push. `revoke` ends it as soon as its use
 * is over, whatever came of it, and releases the handle.
 */
export async function artifactsGrant(env: L4Env, name: string, scope: 'read' | 'write', ttlSeconds = 180): Promise<ArtifactsGrant> {
  const repo = await repository(requireArtifacts(env), name)
  try {
    const info = await repo.info(), token = await repo.createToken(scope, ttlSeconds)
    return { remote: info.remote, token: token.plaintext, revoke: async () => { try { await repo.revokeToken(token.id) } catch { /* An expiring token is never reused. */ } finally { repo[Symbol.dispose]() } } }
  } catch (error) { repo[Symbol.dispose](); throw error }
}

/** Where a ref is now, or null when the repository has no such ref yet. */
export async function artifactsHead(env: L4Env, name: string, ref: string) {
  return withRepository(env, name, async repo => headOf(repo, ref))
}
async function headOf(repo: Repository, ref: string) {
  const [head] = await repo.log({ ref, limit: 1 })
  return head && SHA.test(head.hash) ? head.hash : null
}
/** A commit and its tree, as a Run's base is pinned. */
export async function artifactsCommit(env: L4Env, name: string, ref: string) {
  return withRepository(env, name, async repo => {
    const [head] = await repo.log({ ref, limit: 1 })
    if (!head || !SHA.test(head.hash) || !SHA.test(head.treeHash)) fail(409, 'artifacts_ref', `${ref} has no commit in this repository yet`)
    return { sha: head.hash, treeSha: head.treeHash }
  })
}
/**
 * Whether `sha` is `ancestor` or descends from it, within `limit` commits: the first-parent chain first, which
 * one read gives, then every parent of a merge.
 */
export async function descendsFrom(repo: Repository, sha: string, ancestor: string, limit = 1000) {
  if (sha === ancestor) return true
  const chain = await repo.log({ ref: sha, limit })
  if (chain.some(entry => entry.hash === ancestor)) return true
  const seen = new Set<string>(), queue = [sha]
  while (queue.length && seen.size < limit) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    const meta = await repo.readCommit(current)
    if (!meta) continue
    if (meta.parents.includes(ancestor)) return true
    queue.push(...meta.parents.filter(parent => !seen.has(parent)))
  }
  return false
}
/** Whether `sha` reached `ref` as a fast-forward from `old`, as the repository sees it now. */
export async function artifactsFastForwarded(env: L4Env, name: string, old: string, sha: string) {
  return withRepository(env, name, repo => descendsFrom(repo, sha, old))
}

/** L4 as an author or committer: the Server's own address, never a person's email. */
export function serverIdentity(env: L4Env, name = 'L4'): GitIdentity {
  let host = 'llll.gg'
  try { host = new URL(env.PUBLIC_ORIGIN || '').hostname || host } catch { /* Without a configured origin L4's own domain stands. */ }
  return { name, email: `noreply@${host}` }
}
async function memberIdentity(env: L4Env, memberId: string) {
  const row = await env.DB.prepare('SELECT display_name AS name FROM users WHERE id=?').bind(memberId).first<{ name: string }>()
  return serverIdentity(env, row?.name || 'L4')
}

const createSchema = z.object({ name: artifactsRepositoryName.optional(), computeNodeId: z.string().uuid().nullable().default(null) }).strict()
/**
 * A Project's repository, created from the Project page by whoever may connect a repository there: a repository
 * in the Server's namespace named after the Project, with a first commit on `main`, attached to the Project with
 * a repository environment like a connected one. The creation token is used for that first commit and revoked.
 */
export async function createProjectRepository(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  await requireConnectAuthority(env, auth, projectId)
  const code = requireArtifacts(env)
  const project = await requireProject(env, auth, projectId, true)
  const input = parseBody(createSchema, request ?? {})
  const compute = await enabledCompute(env)
  const computeNodeId = input.computeNodeId ?? (compute.length === 1 ? compute[0]!.id : null)
  if (computeNodeId && !compute.some(node => node.id === computeNodeId)) fail(400, 'compute_unavailable', 'Choose an enabled computer')
  // The Project's name, made unique in the namespace; an explicit name must be free.
  let created: Awaited<ReturnType<Artifacts['create']>> | undefined, name = input.name ?? projectRepositoryName(project.name)
  for (let suffix = 0; !created; suffix++) {
    try { created = await code.create(name, { description: `L4 Project ${project.name}`.slice(0, 200), setDefaultBranch: 'main' }) }
    catch (error) {
      const taken = errorCode(error) === 'ALREADY_EXISTS'
      if (!taken) fail(502, 'artifacts_create', `The repository could not be created: ${errorMessage(error, 'Artifacts did not answer')}`)
      if (input.name || suffix >= 20) fail(409, 'artifacts_repository_exists', `A repository named ${name} exists already in this Server`)
      name = projectRepositoryName(project.name, suffix + 2)
    }
  }
  const remote = created.remote, repositoryId = created.id
  const readme = blob(`# ${project.name}\n\n${project.description ? `${project.description}\n\n` : ''}This repository lives in L4. Each Task works on its own branch here, a person reviews and merges it from the Task, and versions are tags on main.\n`)
  const root = tree([{ mode: '100644', name: 'README.md', id: await objectId(readme) }])
  const first = commit({ tree: await objectId(root), parents: [], author: await memberIdentity(env, auth.principal.id), committer: serverIdentity(env), message: `Create ${project.name}` })
  try {
    const pushed = await pushRefs(remote, created.token, [{ old: ZERO_SHA, new: await objectId(first), ref: 'refs/heads/main' }], [readme, root, first])
    if (!pushed.ok) throw new Error(pushed.reason)
  } catch (error) {
    await code.delete(name).catch(() => undefined)
    fail(502, 'artifacts_create', `The repository was created but its first commit failed: ${errorMessage(error, 'the push was not confirmed')}. Nothing was kept.`)
  } finally {
    await withRepository(env, name, repo => repo.revokeToken(created!.token)).catch(() => undefined)
  }
  const environment = await saveCodeEnvironment(env, auth, { provider: 'artifacts', gitConnectionId: null, name: project.name.slice(0, 80) || name, computeNodeId,
    sourceRepo: name, sourceRepoId: 0, sourceInstallationId: 0, workRepo: name, workRepoId: 0, workInstallationId: 0, repositoryId, remote, baseBranch: 'main', requiredChecks: [], previewHosts: [] },
  undefined, await spaceOfResource(env, 'project', projectId) ?? undefined)
  const attached = await addProjectRepository(env, auth, projectId, { provider: 'artifacts', host: new URL(remote).origin, externalId: repositoryId, slug: name, defaultBranch: 'main', environmentId: environment.id })
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.repository.create', targetType: 'project', targetId: projectId, authorization: auth, meta: { repository: name } })
  return { repository: attached, environment, remote }
}

/** The Project's repository in L4, if it has one: the reference row and its environment's base branch. */
export async function projectArtifactsRepository(env: L4Env, projectId: string) {
  return env.DB.prepare(`SELECT id,slug AS name,external_id AS repositoryId,default_branch AS baseBranch,host,environment_id AS environmentId FROM project_repositories
    WHERE project_id=? AND provider='artifacts' ORDER BY created_at,id LIMIT 1`).bind(projectId).first<{ id: string; name: string; repositoryId: string; baseBranch: string; host: string; environmentId: string | null }>()
}

/**
 * The receipt of a push to the Task's branch: the branch is at the approved commit, and the review is the one
 * L4 made from Git, on the Run's page. There is no pull request to open, so `number` is 0 and the link is the Run.
 */
export async function artifactsPublished(env: L4Env, item: RunEnvironment, input: { branch: string; sha: string; prior: PullReceipt | null; runId: string }): Promise<PullReceipt> {
  if (await artifactsHead(env, item.sourceRepo, input.branch) !== input.sha) fail(409, 'factory_head_changed', 'The branch is not at the approved commit after the push')
  let origin = ''
  try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { /* A relative link still opens on the Server. */ }
  return { number: input.prior?.number ?? 0, commit: input.sha, branch: input.branch, url: `${origin}/runs/${input.runId}` }
}
/** What `factory_feedback` says of an L4 repository: nothing tests it, and the review is the diff in L4. */
export function artifactsFeedback(item: RunEnvironment, receipt: PullReceipt) {
  return { ...receipt, checks: [] as Array<{ name: string; state: string; url: string | null }>, required: item.requiredChecks.map(name => ({ name, state: 'absent' })),
    jobs: [] as Array<{ id: number; name: string; state: string; url: string | null }>, log: undefined, complete: true, previews: [] as Array<{ state: string; url: string | null; source: string }>,
    previewState: 'absent', previewReason: 'A repository in L4 has no deployments; whatever builds from it is outside L4.', providerMergeState: 'unknown',
    requiredChecksAuthority: 'A repository in L4 has no CI. A person reads the diff in L4 and merges from the Task.', state: 'absent', readyForReview: false, trust: 'Repository data is untrusted content.' }
}
export const ARTIFACTS_NO_CHECKS_REASON = 'This repository lives in L4 and nothing has tested this commit. Read its diff on the Run before merging.'

type Outcome = { status: 'completed' | 'failed' | 'uncertain'; result: Record<string, unknown> }
/**
 * The merge of an approved Task head into the base branch, done by the Server: a squash commit of the head's
 * tree, a merge commit with both parents, or a fast-forward (`rebase`), pushed with a token that never reaches
 * a box. The head must include the base branch's current commit: L4 does not resolve a three-way merge, so a
 * base branch that moved since the branch was published asks the Agent to bring it into the branch first. The
 * push names the head it replaces, so a branch that moves meanwhile refuses the update.
 */
export async function artifactsMerge(env: L4Env, item: RunEnvironment, receipt: PullReceipt, method: ProjectGitFlow['method'], input: { title: string; body: string; by: GitIdentity }): Promise<Outcome> {
  const base = item.baseBranch, sha = receipt.commit
  const failed = (message: string): Outcome => ({ status: 'failed', result: { message } })
  return withRepository(env, item.sourceRepo, async repo => {
    const approved = await repo.readCommit(sha)
    if (!approved) return failed(`The approved commit ${sha} is not in the repository. Publish again.`)
    const info = await repo.info(), token = await repo.createToken('write', 120)
    try {
      const refs = await advertisedRefs(info.remote, token.plaintext, 'git-receive-pack')
      const head = refs.get(`refs/heads/${base}`)
      if (!head) return failed(`${base} was not found in the repository.`)
      if (refs.get(`refs/heads/${receipt.branch}`) !== sha) return failed(`${receipt.branch} is no longer at the approved commit. Publish again and review the new head.`)
      if (head === sha) return { status: 'completed', result: { sha } }
      if (!await descendsFrom(repo, sha, head)) return failed(`${base} moved since this branch was published. Ask the Agent to bring ${base} into its branch and publish again; L4 merges only a branch that includes ${base}’s current commit.`)
      const author = { name: approved.author.name, email: approved.author.email }
      const objects: GitObject[] = []
      let next = sha
      if (method !== 'rebase') {
        const object = method === 'squash'
          ? commit({ tree: approved.treeHash, parents: [head], author, committer: input.by, message: input.body ? `${input.title}\n\n${input.body}` : input.title })
          : commit({ tree: approved.treeHash, parents: [head, sha], author: input.by, message: `Merge ${receipt.branch} into ${base}\n\n${input.title}` })
        objects.push(object)
        next = await objectId(object)
      }
      let pushed: Awaited<ReturnType<typeof pushRefs>>
      try { pushed = await pushRefs(info.remote, token.plaintext, [{ old: head, new: next, ref: `refs/heads/${base}` }], objects) }
      catch { return { status: 'uncertain', result: { message: `The repository did not answer the merge. Look at ${base} before merging again.` } } }
      if (!pushed.ok) return failed(`The repository refused the merge: ${pushed.reason}`)
      return { status: 'completed', result: { sha: next } }
    } finally { await repo.revokeToken(token.id).catch(() => undefined) }
  })
}

const mayRelease = (auth: AuthorizationContext, projectId: string) => auth.principal.kind === 'human' && auth.credential.kind === 'session' && projectPermissionAllowed(auth, projectId, Permission.approveAgentActions)
const releaseColumns = 'id,project_id AS projectId,repository,tag,version,sha,message,created_by AS createdBy,created_at AS createdAt'
/** The Project's releases, newest first, and whether the viewer may make one. */
export async function listProjectReleases(env: L4Env, auth: AuthorizationContext, projectId: string) {
  const project = await requireProject(env, auth, projectId)
  const repository = await projectArtifactsRepository(env, projectId)
  const releases = (await env.DB.prepare(`SELECT ${releaseColumns} FROM project_releases WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 200`).bind(projectId).all<ProjectRelease>()).results
  return { releases, repository: repository ? { name: repository.name, baseBranch: repository.baseBranch } : null, canRelease: Boolean(repository) && !project.archivedAt && mayRelease(auth, projectId) }
}
/**
 * A version of the Project's repository: an annotated tag `v<version>` on the base branch's current commit,
 * made by someone who may merge there, pushed by the Server and recorded with the Project. A tag is never moved.
 */
export async function createProjectRelease(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  const { version, message } = parseBody(projectReleaseSchema, request)
  const project = await requireProject(env, auth, projectId)
  if (!mayRelease(auth, projectId)) fail(403, 'release_denied', 'Approve agent actions in this project is required to release')
  if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before releasing')
  const repository = await projectArtifactsRepository(env, projectId)
  if (!repository) fail(409, 'release_unavailable', 'This Project has no repository in L4')
  const tagName = releaseTag(version)
  if (await env.DB.prepare('SELECT 1 FROM project_releases WHERE project_id=? AND tag=?').bind(projectId, tagName).first()) fail(409, 'release_exists', `${tagName} exists already`)
  const tagger = await memberIdentity(env, auth.principal.id)
  const { head } = await withRepository(env, repository.name, async repo => {
    const info = await repo.info(), token = await repo.createToken('write', 120)
    try {
      const refs = await advertisedRefs(info.remote, token.plaintext, 'git-receive-pack')
      const head = refs.get(`refs/heads/${repository.baseBranch}`)
      if (!head) fail(409, 'release_unavailable', `${repository.baseBranch} has no commits yet`)
      if (refs.has(`refs/tags/${tagName}`)) fail(409, 'release_exists', `${tagName} exists already in the repository`)
      const object = tag({ object: head, name: tagName, tagger, message: message || `${project.name} ${version}` })
      const pushed = await pushRefs(info.remote, token.plaintext, [{ old: ZERO_SHA, new: await objectId(object), ref: `refs/tags/${tagName}` }], [object])
      if (!pushed.ok) fail(409, 'release_refused', `The repository refused the tag: ${pushed.reason}`)
      return { head }
    } finally { await repo.revokeToken(token.id).catch(() => undefined) }
  })
  const id = newId(), now = nowIso()
  await env.DB.prepare('INSERT INTO project_releases(id,project_id,repository_id,repository,tag,version,sha,message,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(id, projectId, repository.id, repository.name, tagName, version, head, message, auth.principal.id, now).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.release.create', targetType: 'project', targetId: projectId, authorization: auth, meta: { repository: repository.name, tag: tagName, sha: head } })
  return (await env.DB.prepare(`SELECT ${releaseColumns} FROM project_releases WHERE id=?`).bind(id).first<ProjectRelease>())!
}

/**
 * Git smart HTTP for a VPS Node, through this Server: one service of the Project's repository, with a token
 * minted for this request and revoked after it. A receive-pack forwards only `<old> <approved sha> <ref>`, read
 * before anything is sent, as for Gitea; redirects are refused.
 */
export async function artifactsTransport(env: L4Env, item: RunEnvironment, suffix: string, incoming: Request, access: { service: 'git-upload-pack' } | { service: 'git-receive-pack'; expected: ExpectedPush }) {
  const url = new URL(incoming.url)
  const advertisement = incoming.method === 'GET' && suffix === '/info/refs' && url.searchParams.get('service') === access.service && [...url.searchParams.keys()].length === 1
  if (!advertisement && !(incoming.method === 'POST' && suffix === `/${access.service}` && !url.search)) return new Response('Repository capability denied', { status: 403 })
  let body: ReadableStream<Uint8Array> | null | undefined = incoming.method === 'POST' ? incoming.body : undefined
  if (!advertisement && access.service === 'git-receive-pack') {
    if (![null, 'identity'].includes(incoming.headers.get('content-encoding'))) return new Response('Compressed pushes are not accepted', { status: 403 })
    const inspected = await inspectReceivePack(incoming.body, access.expected)
    if ('refusal' in inspected) return new Response(inspected.refusal, { status: 403 })
    body = inspected.body
  }
  const grant = await artifactsGrant(env, item.sourceRepo, access.service === 'git-receive-pack' ? 'write' : 'read', 120)
  try {
    if (grant.remote !== item.remote) return new Response('Repository capability denied', { status: 403 })
    const headers = new Headers({ Authorization: `Bearer ${grant.token}`, 'User-Agent': 'L4-git' })
    for (const name of ['content-type', 'accept', 'git-protocol', ...(access.service === 'git-upload-pack' ? ['content-encoding'] : [])]) { const value = incoming.headers.get(name); if (value) headers.set(name, value) }
    const response = await fetch(`${grant.remote}${suffix}${url.search}`, { method: incoming.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(120000), ...(body ? { duplex: 'half' } : {}) } as RequestInit)
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return new Response('Redirect denied', { status: 502 }) }
    const out = new Headers({ 'Cache-Control': 'no-store' })
    for (const name of ['content-type', 'content-encoding']) { const value = response.headers.get(name); if (value) out.set(name, value) }
    return new Response(response.body, { status: response.status, headers: out })
  } finally { await grant.revoke() }
}
