import { z } from 'zod'

export const aiFunctions = [
  { id: 'apps.assist', label: 'Help with Apps', description: 'Compose a draft from the requesting Member’s available Database Views.', maxOutputTokens: 2000 },
  { id: 'thread.title', label: 'Thread titles', description: 'Name new threads from their root message. Existing titles stay unchanged.', maxOutputTokens: 120 },
  { id: 'web.search', label: 'Web search', description: 'Choose an OpenRouter model with web search enabled. A configured Exa key takes precedence.', maxOutputTokens: 2000 },
  { id: 'avatar.generate', label: 'Avatars', description: 'Draw profile pictures for agents and members. Needs an OpenRouter model that outputs images, such as Nano Banana.', maxOutputTokens: 2000, requires: 'image-output' },
  { id: 'image.describe', label: 'Image descriptions', description: 'Describe attached images for agents whose model cannot see them.', maxOutputTokens: 600, requires: 'image-input' },
  { id: 'audio.transcribe', label: 'Voice transcription', description: 'Turn voice messages into text for agents.', maxOutputTokens: 2000, requires: 'audio-input' },
] as const
/** The capability a function's model must report in the provider catalog. */
export type AiFunctionRequirement = 'image-output' | 'image-input' | 'audio-input'
export function modelMeetsRequirement(model: { inputs?: readonly string[]; outputs?: readonly string[] }, requires?: AiFunctionRequirement) {
  if (!requires) return true
  if (requires === 'image-output') return Boolean(model.outputs?.includes('image'))
  return Boolean(model.inputs?.includes(requires === 'image-input' ? 'image' : 'audio'))
}
export type AiFunctionId = typeof aiFunctions[number]['id']
export const aiFunctionIdSchema = z.enum(['apps.assist', 'thread.title', 'web.search', 'avatar.generate', 'image.describe', 'audio.transcribe'])
export const aiFunctionConfigSchema = z.object({
  model: z.string().min(1).max(300).nullable(),
}).strict()
export type AiFunctionConfig = z.infer<typeof aiFunctionConfigSchema>
export type AiFunctionDTO = (typeof aiFunctions[number] & { requires?: AiFunctionRequirement }) & AiFunctionConfig & { available: boolean; invalid?: boolean; modelLabel?: string }
