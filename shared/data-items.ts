import { z } from 'zod'
import { DOCUMENT_CONTENT_MAX } from './documents'
import type { DatabaseFieldDTO, LinkedRecordDTO } from './types'
import type { DatabaseValue } from './database'

export const itemContentSchema = {
  title: z.string().trim().min(1).max(500).optional(),
  content: z.string().max(DOCUMENT_CONTENT_MAX).optional(),
  format: z.enum(['html', 'markdown']).default('html'),
  icon: z.string().max(80).nullable().optional(),
  cover: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith('https://'), 'Use an HTTPS cover URL')
    .nullable()
    .optional(),
}
export const createItemSchema = z.object({
  ...itemContentSchema,
  kind: z.enum(['page', 'canvas']).default('page'),
  parentId: z.string().min(1).max(200).nullable().optional(),
  databaseId: z.string().min(1).max(200).nullable().optional(),
})
export const updateItemSchema = z
  .object({ ...itemContentSchema, version: z.number().int().positive() })
  .refine((value) => ['title', 'content', 'icon', 'cover'].some((key) => key in value), 'No changes')
export const moveItemSchema = z
  .object({
    version: z.number().int().positive(),
    parentId: z.string().min(1).max(200).nullable().optional(),
    databaseId: z.string().min(1).max(200).nullable().optional(),
    discardProperties: z.boolean().default(false),
  })
  .refine((value) => 'parentId' in value || 'databaseId' in value, 'Choose a destination')
export type DataItem = {
  id: string
  spaceId: string
  kind: 'page' | 'canvas'
  parentId: string | null
  databaseId: string | null
  title: string
  content: string
  icon: string | null
  cover: string | null
  position: number
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
}
export type DataItemSummary = Omit<DataItem, 'content'>
export type DataItemDetail = DataItem & {
  fields: DatabaseFieldDTO[]
  values: Record<string, DatabaseValue>
  children: DataItemSummary[]
  linked: Record<string, LinkedRecordDTO>
}
export function itemPath(id: string): string {
  return `/items/${encodeURIComponent(id)}`
}
