import type { CodeEnvironmentConfig } from '../../shared/code-environments'
import type { L4Env } from '../../workers/env'
import { gitConnectionProvider, githubConnectionCredentials } from './git-connections'
import { agentRepositories, githubAgentClient } from './github-agent-client'
import { giteaAgentClient, giteaCredentials, giteaRepositories, type GiteaAccess } from './gitea'

/** Whether a connection (or, without one, any connection or the deployment App) can broker repository access. */
export async function gitAgentConfigured(env: L4Env, connectionId?: string | null): Promise<boolean> {
  if (!connectionId) {
    if (env.GITHUB_AGENT_APP_ID && env.GITHUB_AGENT_APP_PRIVATE_KEY) return true
    return Boolean(await env.DB.prepare("SELECT 1 FROM git_connections WHERE provider IN ('github','gitea') AND enabled=1 LIMIT 1").first())
  }
  try {
    if (await gitConnectionProvider(env, connectionId) === 'gitea') return Boolean(await giteaCredentials(env, connectionId))
    return Boolean(await githubConnectionCredentials(env, connectionId))
  } catch { return false }
}
/** Fails closed when the configured connection was disabled or its credential cannot be decrypted. */
export async function requireGitConnection(env: L4Env, item: Pick<CodeEnvironmentConfig, 'provider' | 'gitConnectionId'>) {
  if (item.provider === 'gitea') await giteaCredentials(env, item.gitConnectionId)
  else if (item.gitConnectionId) await githubConnectionCredentials(env, item.gitConnectionId)
}

export type ProviderRepository = { id: number; name: string; installationId: number; fork: boolean; defaultBranch: string; resourceId: string }
export async function discoverRepositories(env: L4Env, connectionId?: string | null, transport: typeof fetch = fetch): Promise<ProviderRepository[]> {
  if (connectionId && await gitConnectionProvider(env, connectionId) === 'gitea') return giteaRepositories(env, connectionId, transport)
  return (await agentRepositories(env, transport, connectionId)).map(repo => ({ ...repo, resourceId: String(repo.id) }))
}

type Environment = Pick<CodeEnvironmentConfig, 'provider' | 'gitConnectionId' | 'sourceRepo' | 'sourceRepoId' | 'sourceInstallationId' | 'workRepo' | 'workRepoId' | 'workInstallationId'>
/** One repository and one operation class. GitHub mints a narrowed token; Gitea's broker enforces the same bounds. */
export async function repositoryClient(env: L4Env, item: Environment, side: 'source' | 'work', access: GiteaAccess, ensure: () => Promise<void> = async () => {}, transport: typeof fetch = fetch) {
  const repository = side === 'source' ? item.sourceRepo : item.workRepo
  if (item.provider === 'gitea') {
    const client = await giteaAgentClient(env, { connectionId: item.gitConnectionId, repository, access }, ensure, transport)
    return { provider: 'gitea' as const, raw: (path: string, method?: string, body?: unknown) => client.raw(path, method, body), json: (path: string, method?: string, body?: unknown) => client.json(path, method, body), web: (path = '') => `${client.host}/${repository}${path}` }
  }
  const client = await githubAgentClient(env, { connectionId: item.gitConnectionId, installationId: side === 'source' ? item.sourceInstallationId : item.workInstallationId,
    repositoryId: side === 'source' ? item.sourceRepoId : item.workRepoId, access }, ensure, transport)
  return { provider: 'github' as const, raw: (path: string, method?: string, body?: unknown) => client.raw(path, method, body), json: (path: string, method?: string, body?: unknown) => client.json(path, method, body), web: (path = '') => `https://github.com/${repository}${path}` }
}
export type RepositoryClient = Awaited<ReturnType<typeof repositoryClient>>
/** Pull request pages differ only by path: GitHub /pull/N, Gitea /pulls/N. */
export const pullPath = (provider: 'github' | 'gitea', number: number) => provider === 'gitea' ? `/pulls/${number}` : `/pull/${number}`
