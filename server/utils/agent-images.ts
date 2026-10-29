import type { ImagePart, TextPart } from 'ai'
import { z } from 'zod'
import { agentImageMaxBytes, agentImageTypes, splitAgentImageMarkers } from '../../shared/agent-images'
import { parseAgentModelRef } from '../../shared/agent-providers'
import { fileStorage } from '../../shared/file-storage'
import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { loadAgentProvider } from './agent-providers'

const openRouterVision = new Map<string, boolean>()
/** Unknown capability is attempted; only a model known to be text-only gets a text notice instead. */
export async function modelAcceptsImages(env: L4Env, reference: string, transport: typeof fetch = fetch): Promise<boolean> {
  const parsed = parseAgentModelRef(reference)
  if (!parsed) return !reference.startsWith('@cf/')
  const provider = await loadAgentProvider(env, parsed.provider)
  const model = provider?.models.find(item => item.id === parsed.model)
  if (model?.inputs) return model.inputs.includes('image')
  if (provider?.kind !== 'openrouter') return true
  // Models saved before discovery recorded modalities: ask OpenRouter's public catalog once per isolate.
  const cached = openRouterVision.get(parsed.model)
  if (cached !== undefined) return cached
  try {
    const response = await transport(`https://openrouter.ai/api/v1/models/${parsed.model.split('/').map(encodeURIComponent).join('/')}/endpoints`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const body = await readLimitedStream(response.body, 500000)
    if (!response.ok || !body.ok) return true
    const modalities = z.object({ data: z.object({ architecture: z.object({ input_modalities: z.array(z.string()) }) }) }).safeParse(JSON.parse(new TextDecoder().decode(body.bytes)))
    if (!modalities.success) return true
    const images = modalities.data.data.architecture.input_modalities.includes('image')
    openRouterVision.set(parsed.model, images)
    return images
  } catch { return true }
}

/** Turns references in user text into image parts the provider SDK sends natively. */
export function agentImageResolver(env: L4Env, run: Pick<AgentRun, 'channelId' | 'initiatedBy'>, acceptsImages: () => Promise<boolean>) {
  let accepts: Promise<boolean> | undefined
  const loaded = new Map<string, Promise<TextPart | ImagePart>>()
  const load = async (id: string): Promise<TextPart | ImagePart> => {
    // Only the initiator's own image in this conversation, still within limits, is readable.
    const row = await env.DB.prepare(`SELECT a.r2_key AS key,a.filename,a.content_type AS type FROM attachments a
      WHERE a.id=? AND a.uploader_id=? AND a.message_id IS NOT NULL AND a.size_bytes<=? AND a.content_type IN (${agentImageTypes.map(() => '?').join(',')})
      AND a.channel_id IN (?, (SELECT parent_id FROM channels WHERE id=?))`)
      .bind(id, run.initiatedBy, agentImageMaxBytes, ...agentImageTypes, run.channelId, run.channelId).first<{ key: string; filename: string; type: string }>()
    if (!row) return { type: 'text', text: '[An attached image is no longer available.]' }
    if (!await (accepts ??= acceptsImages())) return { type: 'text', text: `[The user attached the image "${row.filename}", but the selected model cannot view images. Say so and suggest choosing a model that supports images.]` }
    const object = await fileStorage(env).get(row.key)
    if (!object || object.size > agentImageMaxBytes) return { type: 'text', text: '[An attached image is no longer available.]' }
    return { type: 'image', image: new Uint8Array(await object.arrayBuffer()), mediaType: row.type }
  }
  return {
    count: (text: string) => splitAgentImageMarkers(text).filter(part => part.type === 'image').length,
    async parts(text: string): Promise<string | Array<TextPart | ImagePart>> {
      const parts = splitAgentImageMarkers(text)
      if (!parts.some(part => part.type === 'image')) return text
      return Promise.all(parts.map(part => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text }
        if (!loaded.has(part.id)) loaded.set(part.id, load(part.id))
        return loaded.get(part.id)!
      }))
    },
  }
}
