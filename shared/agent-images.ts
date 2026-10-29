/**
 * Image attachments reach a model as references in the Run prompt, not as bytes:
 * transcripts stay small, and the Server gateway loads each image only after
 * checking it still belongs to the initiating member's conversation.
 */
export const agentImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const agentImageLimit = 4
export const agentImageMaxBytes = 5_000_000
const marker = /\[l4-image:([A-Za-z0-9_-]{8,64})\]/gu

export const agentImageMarker = (id: string) => `[l4-image:${id}]`
/** Member text never carries a reference of its own; only the Server appends them. */
export const stripAgentImageMarkers = (text: string) => text.replace(marker, '')
/** Readable form for people: a reference shows as a short image label. */
export const displayAgentPrompt = (text?: string | null) => (text ?? '').replace(marker, '🖼 Image').trim()
export type AgentImagePart = { type: 'text'; text: string } | { type: 'image'; id: string }
export function splitAgentImageMarkers(text: string): AgentImagePart[] {
  const parts: AgentImagePart[] = []
  let last = 0
  for (const match of text.matchAll(marker)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    parts.push({ type: 'image', id: match[1]! })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}
