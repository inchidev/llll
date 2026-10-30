import { streamText } from 'ai'
import { aiFunctions, aiFunctionConfigSchema, modelMeetsRequirement, type AiFunctionId, type AiFunctionConfig, type AiFunctionDTO } from '../../shared/ai-functions'
import { parseAgentModelRef } from '../../shared/agent-providers'
import { readServerSetting } from '../../shared/server-settings'
import { modelForRun } from '../../workers/ai-runtime'
import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { agentProviderCatalog, chatGPTUsableBy, loadAgentProvider, resolveSavedAgentModel } from './agent-providers'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { asRpc, fail } from './cf'
import { auditStatement, writeAudit } from './messages'
import { inferenceFailure } from './agent-inference-errors'

export const aiFunctionKey = (id: AiFunctionId) => `ai.function.${id}`
export async function aiFunctionConfig(env: L4Env, id: AiFunctionId): Promise<AiFunctionConfig> {
  const raw = await readServerSetting(env.DB, aiFunctionKey(id))
  if (!raw) return { model: null }
  try { return aiFunctionConfigSchema.parse(JSON.parse(raw)) }
  catch { fail(409, 'ai_function_invalid', 'This AI function has an invalid configuration. Choose its model again in Providers.') }
}

/** Function choices are independent of Agent profiles and the Server default. */
export async function aiFunctionCatalog(env: L4Env, actorId: string) {
  const catalog = await agentProviderCatalog(env, { actorId, requireTools: false })
  const functions: AiFunctionDTO[] = await Promise.all(aiFunctions.map(async definition => {
    let config: AiFunctionConfig
    try { config = await aiFunctionConfig(env, definition.id) }
    catch { return { ...definition, model: null, available: false, invalid: true } }
    const selected = parseAgentModelRef(config.model ?? '')
    const provider = selected && catalog.providers.find(provider => provider.id === selected.provider)
    const chosen = provider?.models.find(model => model.id === selected!.model)
    const requires = 'requires' in definition ? definition.requires : undefined
    const available = Boolean(provider?.configured && provider.enabled && chosen && modelMeetsRequirement(chosen, requires)
      && (definition.id !== 'web.search' || (provider.kind === 'openrouter' && provider.webSearch))
      && (definition.id !== 'avatar.generate' || provider.kind === 'openrouter'))
    return { ...definition, ...config, available, ...(chosen && provider ? { modelLabel: `${provider.name} / ${chosen.label || chosen.id}` } : {}) }
  }))
  return { functions, models: catalog.models.map(model => ({ ...model, webSearch: catalog.providers.some(provider => provider.id === parseAgentModelRef(model.value)?.provider && provider.kind === 'openrouter' && provider.webSearch) })) }
}

export async function saveAiFunction(env: L4Env, authorization: AuthorizationContext, id: AiFunctionId, config: AiFunctionConfig) {
  if (!authorization.principal.isOwner) fail(403, 'forbidden', 'Only the owner can assign models to AI functions')
  if (config.model) {
    if (!parseAgentModelRef(config.model)) fail(400, 'model_unavailable', 'Choose a named provider connection and model')
    const catalog = await aiFunctionCatalog(env, authorization.principal.id)
    if (!catalog.models.some(model => model.value === config.model)) fail(400, 'model_unavailable', 'Choose an available model')
    const definition = aiFunctions.find(item => item.id === id)!
    const option = catalog.models.find(model => model.value === config.model)!
    if ('requires' in definition && !modelMeetsRequirement(option, definition.requires)) fail(400, 'model_capability', `${definition.label} needs a model that ${definition.requires === 'image-output' ? 'outputs images' : definition.requires === 'image-input' ? 'reads images' : 'reads audio'}. Load the provider's models again if it should.`)
    if (id === 'avatar.generate' && (await agentProviderCatalog(env, { actorId: authorization.principal.id, requireTools: false })).providers.find(provider => provider.id === parseAgentModelRef(option.value)?.provider)?.kind !== 'openrouter') fail(400, 'model_capability', 'Avatars currently draw with an OpenRouter image model')
    if (id === 'web.search') {
      const provider = catalog.models.find(model => model.value === config.model)
      const parsed = parseAgentModelRef(provider!.value)!
      const connection = (await agentProviderCatalog(env, { actorId: authorization.principal.id, requireTools: false })).providers.find(provider => provider.id === parsed.provider)
      if (connection?.kind !== 'openrouter' || !connection.webSearch) fail(400, 'search_unavailable', 'Choose an OpenRouter connection with web search enabled')
    }
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(aiFunctionKey(id), JSON.stringify(config), new Date().toISOString()),
    await auditStatement(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'ai.function.configure', targetType: 'ai_function', targetId: id, meta: config, authorization }),
  ])
}

export async function resolveAiFunction(env: L4Env, id: AiFunctionId, actorId: string): Promise<string> {
  const config = await aiFunctionConfig(env, id)
  const definition = aiFunctions.find(definition => definition.id === id)!
  if (!config.model) fail(409, 'ai_function_unconfigured', `Choose a model for ${definition.label} in Settings → Agents → Providers`)
  const selected = parseAgentModelRef(config.model)
  const provider = selected ? await loadAgentProvider(env, selected.provider) : null
  if (!selected || !provider?.enabled || !provider.secret || !provider.models.some(model => model.id === selected.model)
    || (provider.kind === 'chatgpt' && !chatGPTUsableBy(provider, actorId))
    || (id === 'web.search' && (provider.kind !== 'openrouter' || !provider.webSearch))) {
    fail(409, 'ai_function_unavailable', `${definition.label} uses an unavailable connection or model. Update its assignment in Providers.`)
  }
  return config.model
}

/** One bounded, tool-free call; models cannot read resources or perform actions. */
export async function inferAiFunction(env: L4Env, authorization: AuthorizationContext, id: AiFunctionId, instructions: string, prompt: string): Promise<string> {
  if (new TextEncoder().encode(prompt).byteLength > 64000) fail(413, 'ai_context_too_large', 'This AI request has too much context. Reduce the number of sources or shorten the request.')
  const reference = await resolveAiFunction(env, id, authorization.principal.id)
  const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`ai-function:${authorization.principal.id}`))
  if (!await limiter.take(20, 60_000)) fail(429, 'rate_limited', 'Too many AI requests. Try again in a minute.')
  const definition = aiFunctions.find(definition => definition.id === id)!
  let providerFailure: unknown
  try {
    const model = await modelForRun(env, reference, '', authorization.principal.id)
    if (typeof model === 'string') fail(503, 'ai_unavailable', 'The selected named model provider is unavailable')
    const response = streamText({ model, instructions, prompt, maxOutputTokens: definition.maxOutputTokens,
      abortSignal: AbortSignal.timeout(30000), maxRetries: 0,
      onError: ({ error }) => { providerFailure = error },
    })
    const text = await response.text
    if (providerFailure) throw providerFailure
    if (text.length > 24000) throw new Error('Model output too large')
    const usage = await response.totalUsage
    await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'ai.function.call', targetType: 'ai_function', targetId: id, meta: { model: reference, status: 'completed', totalTokens: usage.totalTokens ?? null }, authorization })
    return text
  } catch (error) {
    const message = inferenceFailure(providerFailure ?? error)
    await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'ai.function.call', targetType: 'ai_function', targetId: id, meta: { model: reference, status: 'failed', error: message }, authorization })
    fail(502, 'ai_function_failed', message)
  }
}

const avatarBrief = [
  'You draw one profile picture (avatar) for a member or an agent of an L4 Server, where a team chats and works.',
  'Output exactly one square 1:1 image. One subject, centered, filling about 85 percent of the frame, still readable at 24 pixels.',
  'One flat, solid background colour with no gradient, texture or cast shadow, so it can be cut away. No text, letters, numbers, watermarks, borders or frames, and no logos unless the request asks for one.',
  'Friendly and characterful rather than corporate. Never depict a real, identifiable person.',
].join(' ')
const l4Style = [
  'L4 house style: a playful, toy-like 3D object character with a small simple face (two eyes, an optional small mouth), like a designer vinyl figure.',
  'Matte materials and soft studio light. A black-and-white palette with at most one muted accent colour, on a solid off-white background.',
  'The first attached image is the L4 logo: echo its blocky, rounded pixel geometry in the character\'s shape, but do not draw the logo itself.',
].join(' ')
const dataImage = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u
/** The L4 logo from the Server's own assets, when the deployment serves them. */
async function l4Logo(env: L4Env) {
  try {
    const response = await env.ASSETS?.fetch(new Request('https://assets.invalid/brand/logo-512.png'))
    if (!response?.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    return `data:image/png;base64,${btoa(binary)}`
  } catch { return null }
}
/**
 * Draw one avatar with the Avatars function's OpenRouter image model, from a
 * prompt and up to three reference pictures, optionally in the L4 style. The
 * picture comes back for preview; saving it uses the ordinary avatar upload.
 */
export async function generateAvatar(env: L4Env, authorization: AuthorizationContext, input: { name: string; description?: string; references?: string[]; l4Style?: boolean }, transport: typeof fetch = fetch): Promise<string> {
  const references = (input.references ?? []).slice(0, 3)
  if (references.some(reference => !dataImage.test(reference) || reference.length > 2_800_000)) fail(400, 'invalid_reference', 'References must be PNG, JPEG or WebP images up to 2 MB')
  const reference = await resolveAiFunction(env, 'avatar.generate', authorization.principal.id)
  const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`ai-function:${authorization.principal.id}`))
  if (!await limiter.take(20, 60_000)) fail(429, 'rate_limited', 'Too many AI requests. Try again in a minute.')
  const saved = await resolveSavedAgentModel(env, reference, authorization.principal.id)
  if (!saved || saved.id !== 'openrouter') fail(409, 'ai_function_unavailable', 'Avatars need an OpenRouter image model. Choose one in Models → Defaults.')
  const logo = input.l4Style ? await l4Logo(env) : null
  const request = [
    avatarBrief,
    input.l4Style ? l4Style : '',
    `The avatar is for "${input.name.slice(0, 80)}".`,
    input.description ? `Request: ${input.description.slice(0, 1000)}` : 'No further request: choose a fitting subject.',
    references.length ? `The ${logo ? 'remaining' : ''} attached image${references.length > 1 ? 's are' : ' is'} the person's reference${references.length > 1 ? 's' : ''}: follow them as the request describes, without copying any text in them.` : '',
  ].filter(Boolean).join('\n\n')
  const images = [...(logo ? [logo] : []), ...references].map(url => ({ type: 'image_url', image_url: { url } }))
  let status = 'failed'
  try {
    const response = await transport('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${saved.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: saved.model.id, modalities: ['image', 'text'], messages: [{ role: 'user', content: [{ type: 'text', text: request }, ...images] }] }),
    })
    const body = await readLimitedStream(response.body, 8_000_000)
    if (!response.ok || !body.ok) fail(502, 'ai_function_failed', `The image model did not answer (${response.status})`)
    const data = JSON.parse(new TextDecoder().decode(body.bytes)) as { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }> }
    const image = data.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? ''
    // Only an inline PNG, JPEG or WebP no larger than an avatar upload is passed on.
    if (!dataImage.test(image) || image.length > 2_800_000) fail(502, 'ai_function_failed', 'The image model returned no usable picture. Try again or choose another model.')
    status = 'completed'
    return image
  }
  finally {
    await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'ai.function.call', targetType: 'ai_function', targetId: 'avatar.generate', meta: { model: reference, status, references: references.length, l4Style: Boolean(input.l4Style) }, authorization })
  }
}

/**
 * Turn an attachment a chat model cannot take into text with a capable AI
 * function: an image description or a voice transcript. Returns null when the
 * function is not set up or fails, so the caller falls back to a plain notice.
 */
export async function mediaAsText(env: L4Env, id: 'image.describe' | 'audio.transcribe', actorId: string, file: { bytes: Uint8Array; mediaType: string; name: string }): Promise<string | null> {
  let reference: string
  try { reference = await resolveAiFunction(env, id, actorId) }
  catch { return null }
  try {
    const model = await modelForRun(env, reference, '', actorId)
    if (typeof model === 'string') return null
    const definition = aiFunctions.find(item => item.id === id)!
    const instruction = id === 'image.describe'
      ? 'Describe this image for someone who cannot see it: what it shows, any visible text verbatim, and details that matter. Plain text, no preamble.'
      : 'Transcribe this voice message verbatim in its original language. Plain text only.'
    const result = streamText({ model, maxOutputTokens: definition.maxOutputTokens, abortSignal: AbortSignal.timeout(60_000), maxRetries: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, id === 'image.describe' ? { type: 'image', image: file.bytes, mediaType: file.mediaType } : { type: 'file', data: file.bytes, mediaType: file.mediaType, filename: file.name }] }] })
    const text = (await result.text).trim()
    return text ? text.slice(0, 8000) : null
  }
  catch { return null }
}
