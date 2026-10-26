import { z } from 'zod'

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
export const codeEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sourceRepo: repository, sourceRepoId: z.number().int().positive(), sourceInstallationId: z.number().int().positive(),
  workRepo: repository, workRepoId: z.number().int().positive(), workInstallationId: z.number().int().positive(),
  baseBranch: z.string().min(1).max(200).default('main'),
  requiredChecks: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  previewHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).max(20).default([]),
}).superRefine((value, context) => {
  if (value.sourceRepoId === value.workRepoId && (value.sourceRepo.toLowerCase() !== value.workRepo.toLowerCase() || value.sourceInstallationId !== value.workInstallationId)) {
    context.addIssue({ code: 'custom', message: 'The same repository must use the same identity and App installation' })
  }
  if ((value.baseBranch.includes('..') || value.baseBranch.includes('[') || /[~^:?*\\\s]/u.test(value.baseBranch) || value.baseBranch.startsWith('/')) || value.baseBranch.endsWith('/')) context.addIssue({ code: 'custom', message: 'Invalid base branch' })
})
export type CodeEnvironmentInput = z.infer<typeof codeEnvironmentSchema>
export type CodeEnvironment = CodeEnvironmentInput & { id: string; enabled: boolean; version: number }
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
