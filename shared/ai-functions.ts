import { z } from 'zod'

export const aiFunctions = [
  { id: 'apps.assist', label: 'Help with Apps', description: 'Compose a draft from the requesting Member’s available Database Views.', maxOutputTokens: 2000 },
  { id: 'thread.title', label: 'Thread titles', description: 'Name new threads from their root message. Existing titles stay unchanged.', maxOutputTokens: 120 },
  { id: 'web.search', label: 'Web search', description: 'Choose an OpenRouter model with web search enabled. A configured Exa key takes precedence.', maxOutputTokens: 2000 },
] as const
export type AiFunctionId = typeof aiFunctions[number]['id']
export const aiFunctionIdSchema = z.enum(['apps.assist', 'thread.title', 'web.search'])
export const aiFunctionConfigSchema = z.object({
  model: z.string().min(1).max(300).nullable(),
}).strict()
export type AiFunctionConfig = z.infer<typeof aiFunctionConfigSchema>
export type AiFunctionDTO = typeof aiFunctions[number] & AiFunctionConfig & { available: boolean; invalid?: boolean }
