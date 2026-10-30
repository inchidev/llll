import { z } from 'zod'
import { giteaConnectSchema, type GitConnection } from '../../shared/git-connections'
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { getServerId } from '../../shared/server-id'
import { newId, nowIso } from '../../shared/ids'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { listGitConnections, requireGitSetupOwner } from './git-connections'
import { writeAudit } from './messages'
import { fail } from './cf'

// The same scope as GitHub connections: one encrypted credential per Server and connection.
const scope = (server: string, id: string) => `git-connection:${server}:${id}`
const user = z.object({ id: z.number().int().positive(), login: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/u) })
export type GiteaCredentials = { host: string; account: string; token: string }

async function decode(response: Response, limit = 2_000_000) {
  if (!response.ok) {
    await response.body?.cancel()
    fail(response.status === 404 ? 404 : response.status === 409 || response.status === 422 ? 409 : response.status === 401 || response.status === 403 ? 403 : 502, 'gitea_failed', `Gitea operation failed (${response.status})`)
  }
  const body = await readLimitedStream(response.body, limit)
  if (!body.ok) fail(502, 'gitea_response', 'Gitea response exceeds the execution limit')
  return JSON.parse(new TextDecoder().decode(body.bytes))
}
function request(credentials: Pick<GiteaCredentials, 'host' | 'token'>, path: string, init: { method?: string; body?: unknown; timeout?: number } = {}, transport: typeof fetch = fetch) {
  return transport(`${credentials.host}/api/v1${path}`, { method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(init.timeout ?? 30000),
    headers: { Authorization: `token ${credentials.token}`, Accept: 'application/json', 'User-Agent': 'L4-agent-broker', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body) })
}

/** The Owner pastes a bot account's token. L4 checks it once against Gitea before storing it encrypted. */
export async function connectGitea(env: L4Env, actor: AuthorizationContext, input: z.input<typeof giteaConnectSchema>, transport: typeof fetch = fetch): Promise<GitConnection> {
  requireGitSetupOwner(actor)
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'git_encryption', 'Server credential encryption is unavailable')
  const { host, token, name } = giteaConnectSchema.parse(input)
  let account: z.infer<typeof user>
  try { account = user.parse(await decode(await request({ host, token }, '/user', { timeout: 15000 }, transport), 64000)) }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 403) fail(400, 'gitea_token', 'Gitea did not accept this token')
    fail(502, 'gitea_unreachable', 'Gitea did not answer at this address. Check the address and that this Server can reach it.')
  }
  // Repository read is the minimum useful scope; write scopes are checked when an agent first proposes code.
  try { z.array(z.unknown()).parse(await decode(await request({ host, token }, '/user/repos?limit=1', { timeout: 15000 }, transport), 200000)) }
  catch { fail(400, 'gitea_scope', 'This token cannot list repositories. Give it read and write access to repositories and issues.') }
  const duplicate = await env.DB.prepare("SELECT 1 FROM git_connections WHERE provider='gitea' AND host=? AND app_id=? AND enabled=1").bind(host, String(account.id)).first()
  if (duplicate) fail(409, 'gitea_duplicate', `${account.login} on ${new URL(host).hostname} is already connected`)
  const id = newId(), now = nowIso(), server = await getServerId(env.DB)
  const encrypted = JSON.stringify(await encryptSecret(env.AUTH_SECRET, scope(server, id), token))
  const inserted = await env.DB.prepare(`INSERT INTO git_connections(id,name,provider,host,account,app_id,app_slug,credential_json,created_by,created_at,updated_at)
    SELECT ?,?,'gitea',?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM git_connections)<20 RETURNING id`)
    .bind(id, name || `${account.login} on ${new URL(host).hostname}`, host, account.login, String(account.id), account.login, encrypted, actor.principal.id, now, now).first()
  if (!inserted) fail(429, 'git_connection_limit', 'Git connection limit reached; disable an unused connection first')
  await writeAudit(env, { serverId: server, actorId: actor.principal.id, action: 'git.connection.create', targetType: 'git_connection', targetId: id, meta: { provider: 'gitea', host }, authorization: actor })
  return (await listGitConnections(env)).find(c => c.id === id)!
}

/** Credentials stay inside the Server broker and never appear in connection DTOs, Agent tools or Compute Nodes. */
export async function giteaCredentials(env: L4Env, id?: string | null): Promise<GiteaCredentials> {
  if (!id) fail(409, 'gitea_unconfigured', 'Choose a Gitea connection for this repository')
  const row = await env.DB.prepare("SELECT host,account,credential_json AS credential FROM git_connections WHERE id=? AND provider='gitea' AND enabled=1").bind(id).first<{ host: string; account: string; credential: string }>()
  if (!row || !env.AUTH_SECRET) fail(403, 'git_connection_revoked', 'Selected Git connection is unavailable')
  try { return { host: row.host, account: row.account, token: await decryptSecret(env.AUTH_SECRET, scope(await getServerId(env.DB), id), JSON.parse(row.credential) as EncryptedSecret) } }
  catch { fail(503, 'git_credentials', 'Selected Git connection credentials are unavailable') }
}

const repository = z.object({ id: z.number().int().positive(), full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u), fork: z.boolean(), archived: z.boolean(), default_branch: z.string(),
  permissions: z.object({ pull: z.boolean().optional(), push: z.boolean().optional() }).partial().optional() })
/** Metadata-only discovery: every repository the bot account can push to. */
export async function giteaRepositories(env: L4Env, connectionId: string, transport: typeof fetch = fetch) {
  const credentials = await giteaCredentials(env, connectionId)
  const result: Array<{ id: number; name: string; installationId: number; fork: boolean; defaultBranch: string; resourceId: string }> = []
  for (let page = 1; page <= 20; page++) {
    const repos = z.array(repository).parse(await decode(await request(credentials, `/user/repos?limit=50&page=${page}`, {}, transport)))
    result.push(...repos.filter(repo => !repo.archived && repo.permissions?.push !== false).map(repo => ({ id: repo.id, name: repo.full_name, installationId: 0, fork: repo.fork, defaultBranch: repo.default_branch, resourceId: `gitea:${connectionId}:${repo.id}` })))
    if (repos.length < 50) break
  }
  return result
}

export type GiteaAccess = 'read' | 'work' | 'pull_request' | 'checks' | 'issues' | 'pull_request_read' | 'feedback'
/** A Gitea token cannot be narrowed to one repository or operation, so the broker does it: callers
 * name the repository and operation class, and every request stays inside both. */
export async function giteaAgentClient(env: L4Env, input: { connectionId?: string | null; repository: string; access: GiteaAccess },
  ensure: () => Promise<void> = async () => {}, transport: typeof fetch = fetch) {
  const credentials = await giteaCredentials(env, input.connectionId)
  await ensure()
  const root = `/repos/${input.repository}`
  const writes: Partial<Record<GiteaAccess, RegExp>> = {
    work: /^\/(?:contents|branches)$/u,
    pull_request: /^\/pulls(?:\/\d+)?$/u,
  }
  return {
    host: credentials.host,
    async raw(path: string, method = 'GET', body?: unknown) {
      // Callers supply operation-specific paths, never a model-selected URL, repository or method.
      if (!(path === root || path.startsWith(root + '/') || path.startsWith(root + '?')) || path.includes('..') || path.includes('://')) throw new Error('Invalid broker path')
      if (method !== 'GET' && !writes[input.access]?.test(path.slice(root.length).split('?')[0]!)) throw new Error('Operation is outside this repository capability')
      await ensure()
      return request(credentials, path, { method, body }, transport)
    },
    async json(path: string, method = 'GET', body?: unknown) {
      return decode(await this.raw(path, method, body))
    },
  }
}
export type GiteaAgentClient = Awaited<ReturnType<typeof giteaAgentClient>>

/** The clone address of a repository on a connection's Gitea. */
export async function giteaRemote(env: L4Env, connectionId: string | null | undefined, repository: string) {
  return `${(await giteaCredentials(env, connectionId)).host}/${repository}.git`
}
/** Git smart-HTTP read access for one repository. Only upload-pack, never receive-pack; redirects are refused. */
export async function giteaSourceFetch(env: L4Env, connectionId: string | null | undefined, repository: string, suffix: string, incoming: Request) {
  const url = new URL(incoming.url)
  const allowed = incoming.method === 'GET' && suffix === '/info/refs' && url.searchParams.get('service') === 'git-upload-pack' && [...url.searchParams.keys()].length === 1
    || incoming.method === 'POST' && suffix === '/git-upload-pack' && !url.search
  if (!allowed) return new Response('Repository capability denied', { status: 403 })
  const credentials = await giteaCredentials(env, connectionId)
  const headers = new Headers({ Authorization: 'Basic ' + btoa(`${credentials.account}:${credentials.token}`), 'User-Agent': 'L4-source-broker' })
  for (const name of ['content-type', 'accept', 'git-protocol', 'content-encoding']) { const value = incoming.headers.get(name); if (value) headers.set(name, value) }
  const response = await fetch(`${credentials.host}/${repository}.git${suffix}${url.search}`, { method: incoming.method, headers, body: incoming.method === 'POST' ? incoming.body : undefined, redirect: 'manual', signal: AbortSignal.timeout(120000) })
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return new Response('Redirect denied', { status: 502 }) }
  const out = new Headers({ 'Cache-Control': 'no-store' })
  for (const name of ['content-type', 'content-encoding']) { const value = response.headers.get(name); if (value) out.set(name, value) }
  return new Response(response.body, { status: response.status, headers: out })
}
