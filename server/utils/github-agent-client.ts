import { githubPkcs8 } from '../../shared/github-key'
import { githubConnectionCredentials } from './git-connections'
import { importPKCS8, SignJWT } from 'jose'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { fail } from './cf'

const version = '2026-03-10'
export async function githubAgentConfigured(env: L4Env, connectionId?: string | null): Promise<boolean> {
  if (connectionId) return Boolean(await githubConnectionCredentials(env, connectionId))
  if (env.GITHUB_AGENT_APP_ID && env.GITHUB_AGENT_APP_PRIVATE_KEY) return true
  return Boolean(await env.DB.prepare("SELECT 1 FROM git_connections WHERE provider='github' AND enabled=1 LIMIT 1").first())
}

export { githubPkcs8 } from '../../shared/github-key'

async function decode(response: Response) {
  if (!response.ok) {
    await response.body?.cancel()
    fail(response.status === 404 ? 404 : response.status === 422 ? 409 : 502, 'github_failed', `GitHub operation failed (${response.status})`)
  }
  const body = await readLimitedStream(response.body, 2_000_000)
  if (!body.ok) fail(502, 'github_response', 'GitHub response exceeds the execution limit')
  return JSON.parse(new TextDecoder().decode(body.bytes))
}

/** A token is limited to one repository and one operation class; it never crosses the gateway. */
export async function githubAgentClient(env: L4Env, input: { connectionId?: string | null; installationId: number; repositoryId: number; access: 'read' | 'work' | 'pull_request' | 'checks' | 'issues' | 'pull_request_read' | 'feedback' },
  ensure: () => Promise<void> = async () => {}, transport: typeof fetch = fetch) {
  if (!await githubConnectionCredentials(env, input.connectionId)) fail(409, 'github_unconfigured', 'Choose a configured GitHub App connection for this repository')
  await ensure()
  const jwt = await appJwt(env, input.connectionId)
  const tokenResult = await decode(await transport(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'User-Agent': 'L4-agent-broker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [input.repositoryId], permissions: { contents: input.access === 'work' ? 'write' : 'read',
      ...(input.access === 'pull_request' ? { pull_requests: 'write' } : {}), ...(input.access === 'pull_request_read' ? { pull_requests: 'read' } : {}), ...(input.access === 'issues' ? { issues: 'read' } : {}), ...(['checks','feedback'].includes(input.access) ? { checks: 'read', statuses: 'read', pull_requests: 'read' } : {}), ...(input.access === 'feedback' ? { actions: 'read', deployments: 'read' } : {}) } }),
  })) as { token?: string }
  const token = tokenResult.token
  if (!token) fail(502, 'github_response', 'GitHub did not issue a repository capability')
  return {
    async raw(path: string, method = 'GET', body?: unknown) {
      // Callers supply operation-specific paths, never a model-selected URL or method.
      if (!path.startsWith('/repos/') || path.includes('..') || path.includes('://')) throw new Error('Invalid broker path')
      await ensure()
      return transport(`https://api.github.com${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'User-Agent': 'L4-agent-broker', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) })
    },
    async json(path: string, method = 'GET', body?: unknown) {
      return decode(await this.raw(path, method, body))
    },
  }
}

async function appJwt(env: L4Env, connectionId?: string | null) {
  const config = await githubConnectionCredentials(env, connectionId)
  if (!config) fail(409, 'github_unconfigured', 'Choose a configured GitHub App connection')
  const now = Math.floor(Date.now() / 1000)
  const key = await importPKCS8(githubPkcs8(config.privateKey.replace(/\\n/gu, '\n')), 'RS256')
  return await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(String(config.appId)).setIssuedAt(now - 60).setExpirationTime(now + 540).sign(key)
}

/** Trusted source-fetch broker only: a single-repository read credential, never an Agent/workspace credential. */
export async function githubSourceGrant(env: L4Env, input: { connectionId?: string | null; installationId: number; repositoryId: number }, ensure: () => Promise<void>) {
  await ensure()
  const jwt = await appJwt(env, input.connectionId)
  const response = await decode(await fetch(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'User-Agent': 'L4-source-broker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [input.repositoryId], permissions: { contents: 'read' } }),
  })) as { token?: string }
  if (!response.token) fail(502, 'github_response', 'GitHub did not issue a source capability')
  try { await ensure() } catch (error) {
    try {
      const revoked = await fetch('https://api.github.com/installation/token', { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${response.token}`, 'User-Agent': 'L4-source-broker', 'X-GitHub-Api-Version': version } })
      await revoked.body?.cancel()
    } catch { /* The unused single-repository read capability is never delivered or reused. */ }
    throw error
  }
  return response.token
}

export type AgentRepository = { id: number; name: string; installationId: number; fork: boolean; defaultBranch: string }
/** Metadata-only discovery for Server administration. Execution still mints single-repository tokens. */
export async function agentRepositories(env: L4Env, transport: typeof fetch = fetch, connectionId?: string | null): Promise<AgentRepository[]> {
  if (!await githubConnectionCredentials(env, connectionId)) return []
  const jwt = await appJwt(env, connectionId)
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'User-Agent': 'L4-agent-broker' })
  const request = (path: string, token: string, body?: unknown) => transport(`https://api.github.com${path}`, {
    headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(20000),
  })
  const result: AgentRepository[] = []
  for (let page = 1; page <= 10; page++) {
    const grants = await decode(await request(`/app/installations?per_page=100&page=${page}`, jwt)) as Array<{ id: number; suspended_at: string | null }>
    for (const grant of grants) {
      if (grant.suspended_at) continue
      const capability = await decode(await request(`/app/installations/${grant.id}/access_tokens`, jwt, { permissions: { metadata: 'read' } })) as { token: string }
      try {
        for (let repoPage = 1; repoPage <= 10; repoPage++) {
          const repos = await decode(await request(`/installation/repositories?per_page=100&page=${repoPage}`, capability.token)) as { repositories: Array<{ id: number; full_name: string; fork: boolean; archived: boolean; default_branch: string }> }
          result.push(...repos.repositories.filter(repo => !repo.archived).map(repo => ({ id: repo.id, name: repo.full_name, installationId: grant.id, fork: repo.fork, defaultBranch: repo.default_branch })))
          if (repos.repositories.length < 100) break
        }
      } finally {
        const revoked = await transport('https://api.github.com/installation/token', { method: 'DELETE', redirect: 'manual', headers: headers(capability.token), signal: AbortSignal.timeout(10000) })
        if (!revoked.ok) { await revoked.body?.cancel(); fail(502, 'github_failed', 'GitHub discovery capability could not be revoked') }
      }
    }
    if (grants.length < 100) break
  }
  return result
}
