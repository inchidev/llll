import { z } from 'zod'

export const RESOURCE_KINDS = ['projects', 'boards', 'databases', 'documents', 'canvases', 'repositories'] as const
export type ResourceKind = typeof RESOURCE_KINDS[number]
export const resourceAccessSchema = z.object({
  projects: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  boards: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  databases: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  documents: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  canvases: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  repositories: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
}).strict()
export type ResourceAccess = z.infer<typeof resourceAccessSchema>

export function parseResourceAccess(value: string | null | undefined): ResourceAccess {
  if (!value) return {}
  try {
    return resourceAccessSchema.parse(JSON.parse(value))
  } catch {
    // Corrupt policy never becomes unrestricted access.
    return { projects: [], boards: [], databases: [], documents: [], canvases: [], repositories: [] }
  }
}

export function resourceAccessAllows(access: ResourceAccess | undefined, kind: ResourceKind, id: string): boolean {
  const allowed = access?.[kind]
  return allowed == null || allowed.includes(id)
}

export function resourceAccessWithin(child: ResourceAccess, parent: ResourceAccess | undefined): boolean {
  return RESOURCE_KINDS.every(kind => {
    const limit = parent?.[kind]
    return limit == null || (Array.isArray(child[kind]) && child[kind]!.every(id => limit.includes(id)))
  })
}
