import { z } from 'zod'

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
export const codeEnvironmentSchema = z.object({
  // The Server sets this from the chosen connection. Older configurations are GitHub.
  provider: z.enum(['github', 'gitea']).default('github'),
  computeNodeId: z.string().uuid().nullable().optional(),
  gitConnectionId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(80),
  sourceRepo: repository, sourceRepoId: z.number().int().positive(), sourceInstallationId: z.number().int().nonnegative(),
  workRepo: repository, workRepoId: z.number().int().positive(), workInstallationId: z.number().int().nonnegative(),
  baseBranch: z.string().min(1).max(200).default('main'),
  requiredChecks: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  previewHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).max(20).default([]),
}).superRefine((value, context) => {
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
 * carry their connection to never collide with a GitHub repository or another Gitea. */
export function repositoryResourceId(item: Pick<CodeEnvironmentConfig, 'provider' | 'gitConnectionId' | 'sourceRepoId'>) {
  return item.provider === 'gitea' ? `gitea:${item.gitConnectionId}:${item.sourceRepoId}` : String(item.sourceRepoId)
}
export type CodeEnvironment = CodeEnvironmentConfig & { id: string; enabled: boolean; version: number }
export type RunEnvironment = CodeEnvironment & { baseSha: string; baseTreeSha: string }

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
