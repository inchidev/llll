import { importPKCS8 } from 'jose'
import { githubPkcs8 } from '../../shared/github-key'
import { z } from 'zod'
import { githubSetupSchema, type GitConnection } from '../../shared/git-connections'
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { getServerId } from '../../shared/server-id'
import { newId, nowIso } from '../../shared/ids'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { writeAudit } from './messages'
import { fail } from './cf'

const columns = 'id,name,provider,host,account,app_id AS appId,app_slug AS appSlug,enabled'
type Row = Omit<GitConnection, 'enabled' | 'setupUrl'> & { enabled: number }
const scope = (server: string, id: string) => `git-connection:${server}:${id}`
export function requireGitSetupOwner(actor: AuthorizationContext) {
  if (!actor.principal.isOwner || actor.principal.kind !== 'human' || actor.credential.kind !== 'session' || actor.delegation) fail(403, 'git_setup_denied', 'Only the Server Owner can configure Git provider credentials')
}
export async function listGitConnections(env: L4Env): Promise<GitConnection[]> {
  const rows = await env.DB.prepare(`SELECT ${columns} FROM git_connections ORDER BY created_at,id LIMIT 20`).all<Row>()
  // A Gitea bot account reaches the repositories it collaborates on; its profile lists them.
  return rows.results.map(r => ({ ...r, enabled: Boolean(r.enabled), setupUrl: r.provider === 'gitea' ? `${r.host}/${r.account}` : `https://github.com/apps/${r.appSlug}/installations/new` }))
}
/** The provider of an enabled connection, or null for the deployment-configured GitHub App. */
export async function gitConnectionProvider(env: L4Env, id?: string | null) {
  if (!id) return 'github' as const
  const row = await env.DB.prepare('SELECT provider FROM git_connections WHERE id=? AND enabled=1').bind(id).first<{ provider: string }>()
  if (!row || !['github', 'gitea'].includes(row.provider)) fail(403, 'git_connection_revoked', 'Selected Git connection is unavailable')
  return row.provider as 'github' | 'gitea'
}
const digest = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('')
export async function prepareGithubSetup(env: L4Env, actor: AuthorizationContext, request: unknown) {
  requireGitSetupOwner(actor)
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'git_encryption', 'Server credential encryption is unavailable')
  const input = githubSetupSchema.parse(request)
  let origin: URL
  try { origin = new URL(env.PUBLIC_ORIGIN || '') } catch { fail(409, 'git_origin', 'Configure this Server’s public origin before connecting GitHub') }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) fail(409, 'git_origin', 'GitHub setup needs a configured HTTPS Server origin')
  const account = input.organization ? input.account! : ''
  const name = input.name || `L4 ${origin.hostname}`.slice(0, 34).trim()
  const state = [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join(''), now = nowIso()
  const admitted = await env.DB.prepare(`INSERT INTO git_setup_requests(state_hash,name,account,actor_id,origin,status,created_at,expires_at)
    SELECT ?,?,?,?,?,'pending',?,? WHERE (SELECT count(*) FROM git_setup_requests WHERE actor_id=? AND expires_at>?)<5 AND (SELECT count(*) FROM git_connections)<20 RETURNING state_hash`)
    .bind(await digest(state),name,account,actor.principal.id,origin.origin,now,new Date(Date.now()+600000).toISOString(),actor.principal.id,now).first()
  if (!admitted) fail(429, 'git_setup_budget', 'GitHub setup limit reached; finish an existing request or wait for expiry')
  return { actionUrl: input.organization ? `https://github.com/organizations/${account}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`,
    manifest: { name, url: origin.origin, redirect_url: `${origin.origin}/api/git-connections/github/callback`, public: false,
      description: 'L4 project code collaboration. Access is limited by selected repositories and L4 authorization.',
      setup_url: `${origin.origin}/server/${actor.serverId}/settings?section=environments`,
      // No webhook is used: GitHub rejects localhost webhook URLs even when inactive.
      // Omitting the webhook also avoids registering an unused public endpoint.
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'read', checks: 'read', statuses: 'read', actions: 'read', deployments: 'read', metadata: 'read' }, default_events: [] } }
}
const resultSchema = z.object({ id: z.number().int().positive(), slug: z.string().regex(/^[A-Za-z0-9-]+$/u), name: z.string().min(1).max(100).optional(), pem: z.string().min(100).max(20000), owner: z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/u), type: z.string().optional() }) })
/** Explicit owner recovery for an unconsumed state after a slow GitHub sign-in
 * or approval. Never reopen an exchange whose outcome may be uncertain. */
export async function reopenGithubSetup(env: L4Env, actor: AuthorizationContext, state: string) {
  requireGitSetupOwner(actor)
  if (!/^[a-f0-9]{64}$/u.test(state)) fail(400, 'git_setup_invalid', 'Invalid GitHub setup state')
  let origin: string
  try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'git_origin', 'Server origin changed') }
  const now = nowIso()
  const renewed = await env.DB.prepare("UPDATE git_setup_requests SET expires_at=? WHERE state_hash=? AND actor_id=? AND origin=? AND status='pending' AND created_at>? RETURNING state_hash")
    .bind(new Date(Date.now() + 600000).toISOString(), await digest(state), actor.principal.id, origin, new Date(Date.now() - 86400000).toISOString()).first()
  if (!renewed) fail(409, 'git_setup_expired', 'This setup cannot be resumed; start a new connection')
  await writeAudit(env, { serverId: await getServerId(env.DB), actorId: actor.principal.id, action: 'git.connection.resume', targetType: 'server', targetId: actor.serverId, meta: { resumedAt: now } })
}
export async function completeGithubSetup(env: L4Env, actor: AuthorizationContext, code: string, state: string, transport: typeof fetch = fetch) {
  requireGitSetupOwner(actor)
  if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(code) || !/^[a-f0-9]{64}$/u.test(state)) fail(400, 'git_setup_invalid', 'Invalid GitHub setup response')
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'git_encryption', 'Server credential encryption is unavailable')
  const stateHash = await digest(state)
  let origin: string
  try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'git_origin', 'Server origin changed; start GitHub setup again') }
  const claimed = await env.DB.prepare("UPDATE git_setup_requests SET status='exchanging' WHERE state_hash=? AND actor_id=? AND status='pending' AND expires_at>? AND origin=? RETURNING name,account")
    .bind(stateHash, actor.principal.id, nowIso(), origin).first<{name:string;account:string}>()
  if (!claimed) fail(409, 'git_setup_expired', 'GitHub setup expired or was already used; start again')
  try {
    const r = await transport(`https://api.github.com/app-manifests/${code}/conversions`, { method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'L4-git-setup'} })
    if (!r.ok) { await r.body?.cancel(); throw Error('GitHub exchange unavailable') }
    const bytes = await readLimitedStream(r.body,64000)
    if (!bytes.ok) throw Error('GitHub exchange unavailable')
    const parsed = resultSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes.bytes)))
    // An organization setup must come back owned by that organization. A personal
    // setup has no expected login and is owned by whoever GitHub signed in.
    const expected = claimed.account ? parsed.data?.owner.login.toLowerCase() === claimed.account.toLowerCase() : parsed.data?.owner.type !== 'Organization'
    if (!parsed.success || !expected || !/-----BEGIN (?:RSA )?PRIVATE KEY-----/u.test(parsed.data.pem)) throw Error('GitHub identity mismatch')
    const data=parsed.data
    await importPKCS8(githubPkcs8(data.pem), 'RS256')
    const id=newId(),now=nowIso(),server=await getServerId(env.DB)
    const encrypted=JSON.stringify(await encryptSecret(env.AUTH_SECRET,scope(server,id),data.pem))
    await env.DB.batch([
      env.DB.prepare("INSERT INTO git_connections(id,name,provider,host,account,app_id,app_slug,credential_json,created_by,created_at,updated_at) VALUES(?,?,'github','https://github.com',?,?,?,?,?,?,?)").bind(id,data.name||claimed.name,data.owner.login,String(data.id),data.slug,encrypted,actor.principal.id,now,now),
      env.DB.prepare("UPDATE git_setup_requests SET status='complete' WHERE state_hash=? AND status='exchanging'").bind(stateHash),
    ])
    await writeAudit(env,{serverId:server,actorId:actor.principal.id,action:'git.connection.create',targetType:'git_connection',targetId:id,authorization:actor})
    return (await listGitConnections(env)).find(c=>c.id===id)!
  } catch {
    await env.DB.prepare("UPDATE git_setup_requests SET status='failed' WHERE state_hash=? AND status='exchanging'").bind(stateHash).run()
    fail(502,'git_setup_failed','GitHub setup could not be completed. No uncertain exchange will be retried; review Apps in your GitHub account before starting again.')
  }
}
/** Credentials remain inside the Server broker and are never included in connection DTOs. */
export async function githubConnectionCredentials(env: L4Env, id?: string | null) {
  if (!id) return env.GITHUB_AGENT_APP_ID && env.GITHUB_AGENT_APP_PRIVATE_KEY ? { appId: env.GITHUB_AGENT_APP_ID, privateKey: env.GITHUB_AGENT_APP_PRIVATE_KEY } : null
  const row=await env.DB.prepare("SELECT app_id AS appId,credential_json AS credential FROM git_connections WHERE id=? AND provider='github' AND host='https://github.com' AND enabled=1").bind(id).first<{appId:string;credential:string}>()
  if (!row || !env.AUTH_SECRET) fail(403,'git_connection_revoked','Selected Git connection is unavailable')
  try { return { appId:row.appId, privateKey:await decryptSecret(env.AUTH_SECRET,scope(await getServerId(env.DB),id),JSON.parse(row.credential) as EncryptedSecret) } }
  catch { fail(503,'git_credentials','Selected Git connection credentials are unavailable') }
}
export async function disableGitConnection(env:L4Env,actor:AuthorizationContext,id:string) {
  requireGitSetupOwner(actor)
  const r=await env.DB.prepare('UPDATE git_connections SET enabled=0,updated_at=? WHERE id=? RETURNING id').bind(nowIso(),id).first()
  if (!r) fail(404,'not_found','Git connection not found')
  await writeAudit(env,{serverId:actor.serverId,actorId:actor.principal.id,action:'git.connection.disable',targetType:'git_connection',targetId:id,authorization:actor})
}
