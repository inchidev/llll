import { importPKCS8, SignJWT } from 'jose'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { fail } from './cf'

const version = '2026-03-10'
export function githubAgentConfigured(env: L4Env): boolean {
  return Boolean(env.GITHUB_AGENT_APP_ID && env.GITHUB_AGENT_APP_PRIVATE_KEY)
}

/** GitHub downloads PKCS#1 keys; WebCrypto uses the same RSA key inside a PKCS#8 wrapper. */
export function githubPkcs8(pem: string): string {
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) return pem
  const binary = atob(pem.replace(/-----[^-]+-----|\s/gu, ''))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const der = (tag: number, value: number[]) => {
    let length = value.length
    const encoded = []
    do { encoded.unshift(length & 255); length >>>= 8 } while (length)
    return [tag, ...(value.length < 128 ? [value.length] : [128 | encoded.length, ...encoded]), ...value]
  }
  const wrapped = der(48, [2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0, ...der(4, [...bytes])])
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...wrapped)).match(/.{1,64}/gu)!.join('\n')}\n-----END PRIVATE KEY-----`
}

async function decode(response: Response) {
  const body = await readLimitedStream(response.body, 2_000_000)
  if (!body.ok) fail(502, 'github_response', 'GitHub response exceeds the execution limit')
  if (!response.ok) fail(response.status === 404 ? 404 : response.status === 422 ? 409 : 502, 'github_failed', `GitHub operation failed (${response.status})`)
  return JSON.parse(new TextDecoder().decode(body.bytes))
}

/** A token is limited to one repository and one operation class; it never crosses the gateway. */
export async function githubAgentClient(env: L4Env, input: { installationId: number; repositoryId: number; access: 'read' | 'work' | 'pull_request' | 'checks' },
  ensure: () => Promise<void> = async () => {}, transport: typeof fetch = fetch) {
  if (!githubAgentConfigured(env)) fail(409, 'github_unconfigured', 'Configure a dedicated GitHub App for agent repositories')
  await ensure()
  const jwt = await appJwt(env)
  const tokenResult = await decode(await transport(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'User-Agent': 'L4-agent-broker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [input.repositoryId], permissions: { contents: input.access === 'work' ? 'write' : 'read',
      ...(input.access === 'pull_request' ? { pull_requests: 'write' } : {}), ...(input.access === 'checks' ? { checks: 'read', statuses: 'read', pull_requests: 'read' } : {}) } }),
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

async function appJwt(env: L4Env) {
  const now = Math.floor(Date.now() / 1000)
  const key = await importPKCS8(githubPkcs8(env.GITHUB_AGENT_APP_PRIVATE_KEY!.replace(/\\n/gu, '\n')), 'RS256')
  return await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.GITHUB_AGENT_APP_ID!).setIssuedAt(now - 60).setExpirationTime(now + 540).sign(key)
}

export type AgentRepository = { id: number; name: string; installationId: number; fork: boolean; defaultBranch: string }
/** Metadata-only discovery for Server administration. Execution still mints single-repository tokens. */
export async function agentRepositories(env: L4Env): Promise<AgentRepository[]> {
  if (!githubAgentConfigured(env)) return []
  const jwt = await appJwt(env)
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'User-Agent': 'L4-agent-broker' })
  const request = (path: string, token: string, body?: unknown) => fetch(`https://api.github.com${path}`, {
    headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(20000),
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
      } finally { await fetch('https://api.github.com/installation/token', { method: 'DELETE', headers: headers(capability.token), signal: AbortSignal.timeout(10000) }) }
    }
    if (grants.length < 100) break
  }
  return result
}
