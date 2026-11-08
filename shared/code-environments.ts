import { z } from 'zod'

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
/** An Artifacts repository is named inside the Server's own namespace, without an owner (ADR 0013). */
export const artifactsRepositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/u)
const sha = z.string().regex(/^[a-f0-9]{40}$/u)
export const codeEnvironmentSchema = z.object({
  // The Server sets this from the chosen connection, or `artifacts` for a repository it holds itself. Older configurations are GitHub.
  provider: z.enum(['github', 'gitea', 'artifacts']).default('github'),
  computeNodeId: z.string().uuid().nullable().optional(),
  gitConnectionId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(80),
  sourceRepo: z.string().min(1).max(300), sourceRepoId: z.number().int().nonnegative(), sourceInstallationId: z.number().int().nonnegative(),
  workRepo: z.string().min(1).max(300), workRepoId: z.number().int().nonnegative(), workInstallationId: z.number().int().nonnegative(),
  /** Artifacts only: the repository's id in the namespace and its Git remote, as the binding reported them. */
  repositoryId: z.string().min(1).max(100).optional(),
  remote: z.string().url().max(500).optional(),
  baseBranch: z.string().min(1).max(200).default('main'),
  // Empty: every check CI reports must pass, and a commit without any stays unverified.
  requiredChecks: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  previewHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).max(20).default([]),
}).superRefine((value, context) => {
  if (value.provider === 'artifacts') {
    // The Server's own namespace: no connection, no App grant, no provider id; the repository is named and its remote known.
    if (!artifactsRepositoryName.safeParse(value.sourceRepo).success || value.workRepo !== value.sourceRepo) context.addIssue({ code: 'custom', message: 'An L4 repository is one name inside this Server' })
    if (value.gitConnectionId || value.sourceRepoId !== 0 || value.workRepoId !== 0 || value.sourceInstallationId !== 0 || value.workInstallationId !== 0) context.addIssue({ code: 'custom', message: 'An L4 repository needs no Git connection' })
    if (!value.repositoryId || !value.remote || !/^https:\/\//u.test(value.remote)) context.addIssue({ code: 'custom', message: 'An L4 repository needs its id and HTTPS remote' })
  } else {
    if (!repository.safeParse(value.sourceRepo).success || !repository.safeParse(value.workRepo).success) context.addIssue({ code: 'custom', message: 'Name repositories as owner/name' })
    if (value.sourceRepoId <= 0 || value.workRepoId <= 0) context.addIssue({ code: 'custom', message: 'Choose a repository the connection can reach' })
    if (value.repositoryId || value.remote) context.addIssue({ code: 'custom', message: 'Only an L4 repository carries its remote' })
  }
  // Gitea has no App grants: its repositories carry grant 0 and always need an explicit connection.
  if (value.provider === 'gitea' && (!value.gitConnectionId || value.sourceInstallationId !== 0 || value.workInstallationId !== 0)) context.addIssue({ code: 'custom', message: 'Choose a Gitea connection for this repository' })
  if (value.provider === 'github' && (value.sourceInstallationId === 0 || value.workInstallationId === 0)) context.addIssue({ code: 'custom', message: 'Choose a repository the GitHub App can reach' })
  if (value.sourceRepoId === value.workRepoId && (value.sourceRepo.toLowerCase() !== value.workRepo.toLowerCase() || value.sourceInstallationId !== value.workInstallationId)) {
    context.addIssue({ code: 'custom', message: 'The same repository must use the same identity and App grant' })
  }
  if ((value.baseBranch.includes('..') || value.baseBranch.includes('[') || /[~^:?*\\\s]/u.test(value.baseBranch) || value.baseBranch.startsWith('/')) || value.baseBranch.endsWith('/')) context.addIssue({ code: 'custom', message: 'Invalid base branch' })
})
export type CodeEnvironmentInput = z.input<typeof codeEnvironmentSchema>
export type CodeEnvironmentConfig = z.infer<typeof codeEnvironmentSchema>
/** Role repository scopes name GitHub repositories by ID. Gitea IDs are numbered per server, so they
 * carry their connection to never collide with a GitHub repository or another Gitea. An L4 repository is
 * named inside this Server's own namespace. */
export function repositoryResourceId(item: Pick<CodeEnvironmentConfig, 'provider' | 'gitConnectionId' | 'sourceRepoId' | 'sourceRepo'>) {
  if (item.provider === 'artifacts') return `artifacts:${item.sourceRepo}`
  return item.provider === 'gitea' ? `gitea:${item.gitConnectionId}:${item.sourceRepoId}` : String(item.sourceRepoId)
}
export type CodeEnvironment = CodeEnvironmentConfig & { id: string; enabled: boolean; version: number }
export type RunEnvironment = CodeEnvironment & { baseSha: string; baseTreeSha: string }
export const commitSha = sha

export const codeProposalSchema = z.object({
  title: z.string().trim().min(1).max(160), body: z.string().trim().max(12000).default(''),
  files: z.array(z.object({
    path: z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.includes('\\')
      && value.split('/').every(part => part && part !== '.' && part !== '..' && !['.git', '.github'].includes(part.toLowerCase())), 'Protected or invalid repository path'),
    content: z.string().max(80000).nullable(), executable: z.boolean().default(false),
  })).min(1).max(100),
}).superRefine((value, context) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) context.addIssue({ code: 'custom', message: 'A file may appear only once' })
  if (new TextEncoder().encode(JSON.stringify(value.files)).byteLength > 85000) context.addIssue({ code: 'custom', message: 'Split this change into smaller proposals' })
})
export type CodeProposalInput = z.infer<typeof codeProposalSchema>
