import { z } from 'zod'
export const projectSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(12000).default('') }).strict()
export const projectPatchSchema = projectSchema.partial().extend({ archived: z.boolean().optional(), version: z.number().int().positive() }).strict()
/** Provider identity is metadata, never a credential or authorization to execute an operation. */
export const projectRepositorySchema = z.object({
  provider: z.enum(['github', 'gitlab', 'gitea', 'cursor']),
  host: z.string().url().max(500).refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash }, 'Use an HTTPS provider origin'),
  externalId: z.string().trim().min(1).max(300).optional(), slug: z.string().trim().max(300).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u), defaultBranch: z.string().trim().min(1).max(200).default('main'),
  environmentId: z.string().min(1).max(200).nullable().optional(),
}).strict()
export type Project = { id: string; name: string; description: string; archivedAt: string | null; version: number; createdAt: string; updatedAt: string }
export type ProjectRepository = { id: string; projectId: string; provider: z.infer<typeof projectRepositorySchema>['provider']; host: string; externalId: string; slug: string; defaultBranch: string; environmentId: string | null; createdAt: string }
