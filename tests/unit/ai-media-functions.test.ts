import { beforeEach, expect, it, vi } from 'vitest'
import { modelMeetsRequirement } from '../../shared/ai-functions'

const state = vi.hoisted(() => ({ text: 'A red cactus with sunglasses.', reference: 'l4:or:google/nano-banana' as string | null }))
vi.mock('ai', () => ({ streamText: vi.fn(() => ({ text: Promise.resolve(state.text), totalUsage: Promise.resolve({}) })) }))
vi.mock('../../workers/ai-runtime', () => ({ modelForRun: async () => ({ provider: 'openrouter' }) }))
vi.mock('../../server/utils/messages', () => ({ writeAudit: vi.fn(), auditStatement: vi.fn() }))
vi.mock('../../shared/server-settings', () => ({ readServerSetting: async (_db: unknown, key: string) => state.reference ? JSON.stringify({ model: state.reference }) : (key, null) }))
vi.mock('../../server/utils/agent-providers', () => ({
  agentProviderCatalog: vi.fn(), chatGPTUsableBy: () => true,
  loadAgentProvider: async () => ({ kind: 'openrouter', enabled: true, secret: {}, models: [{ id: 'google/nano-banana', outputs: ['image', 'text'], inputs: ['image', 'text', 'audio'] }] }),
  resolveSavedAgentModel: async () => ({ id: 'openrouter', model: { id: 'google/nano-banana' }, apiKey: 'or-key' }),
}))
const { generateAvatar, mediaAsText } = await import('../../server/utils/ai-functions')
const env = { RATE_LIMIT_DO: { getByName: () => ({ take: async () => true }) } } as never
const authorization = { principal: { id: 'member' }, serverId: 'server' } as never
beforeEach(() => { state.reference = 'l4:or:google/nano-banana'; state.text = 'A red cactus with sunglasses.' })

it('matches functions to models by what they read and output', () => {
  expect(modelMeetsRequirement({ outputs: ['image', 'text'] }, 'image-output')).toBe(true)
  expect(modelMeetsRequirement({ inputs: ['text'] }, 'image-input')).toBe(false)
  expect(modelMeetsRequirement({ inputs: ['text', 'audio'] }, 'audio-input')).toBe(true)
  expect(modelMeetsRequirement({}, undefined)).toBe(true)
})

it('draws an avatar with the OpenRouter image model and returns only an inline picture', async () => {
  const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'google/nano-banana', modalities: ['image', 'text'] })
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] } }] })
  })
  await expect(generateAvatar(env, authorization, { name: 'Mike', description: 'a cloud' }, transport)).resolves.toBe('data:image/png;base64,iVBORw0KGgo=')
  const remote = vi.fn(async () => Response.json({ choices: [{ message: { images: [{ image_url: { url: 'https://example.com/a.png' } }] } }] }))
  await expect(generateAvatar(env, authorization, { name: 'Mike' }, remote)).rejects.toMatchObject({ statusCode: 502 })
})

it('describes or transcribes media for text-only agents, and stays quiet when unset', async () => {
  const file = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'a.png' }
  expect(await mediaAsText(env, 'image.describe', 'member', file)).toBe('A red cactus with sunglasses.')
  state.reference = null
  expect(await mediaAsText(env, 'audio.transcribe', 'member', { ...file, mediaType: 'audio/webm' })).toBeNull()
})

it('sends the L4 logo and up to three references with a house-style brief', async () => {
  const logo = new Uint8Array([137, 80, 78, 71])
  const withAssets = { ...env as object, ASSETS: { fetch: async () => new Response(logo) } } as never
  let sent: { messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> } | null = null
  const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body))
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] } }] })
  })
  const reference = 'data:image/jpeg;base64,/9j/4AAQ'
  await generateAvatar(withAssets, authorization, { name: 'Mike', description: 'a cloud', references: [reference, reference], l4Style: true }, transport)
  const content = sent!.messages[0]!.content
  expect(content[0]!.text).toMatch(/L4 house style.*Request: a cloud/su)
  expect(content.filter(part => part.type === 'image_url').map(part => part.image_url!.url)).toEqual(['data:image/png;base64,iVBORw==', reference, reference])
  await expect(generateAvatar(env, authorization, { name: 'Mike', references: ['https://example.com/a.png'] }, transport)).rejects.toMatchObject({ statusCode: 400 })
})
