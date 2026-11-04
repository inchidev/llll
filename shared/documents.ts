import { z } from 'zod'

export const DOCUMENT_CONTENT_MAX = 1_000_000
export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().max(DOCUMENT_CONTENT_MAX).default(''),
  format: z.enum(['html', 'markdown']).default('html'),
})
export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().max(DOCUMENT_CONTENT_MAX).optional(),
  format: z.enum(['html', 'markdown']).default('html'),
  version: z.number().int().positive(),
}).refine(body => body.title !== undefined || body.content !== undefined, 'No changes')

export type DocumentRevision = { version: number; title: string; content: string; savedAt: string }
