import { afterEach, describe, expect, it, vi } from 'vitest'
import { runEmbeddedPi } from '../../workers/agent-pi-durable'

// Exercise the real Pi harness and provider adapter; only DO storage is replaced.
vi.mock('@earendil-works/pi-durable/storage/sqlite/cloudflare', async () => {
  const { MemoryStorage } = await import('@earendil-works/pi-durable')
  return { openDurableObjectSqliteStorage: async () => new MemoryStorage() }
})

afterEach(() => vi.unstubAllGlobals())

const input = {
  prompt: 'Remember CELESTE-742', instructions: 'Answer briefly.',
  modelGateway: { url: 'https://fixture.invalid/v1', token: 'test-capability', model: 'fixture' },
}

describe('embedded Pi conversation archive', () => {
  it('archives in chronological order and restores each message once in the next Run', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      const payload = { id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'CELESTE-742' }, finish_reason: null }] }
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const first = await runEmbeddedPi(input, {} as DurableObjectStorage)
    expect(first.result).toMatchObject({ type: 'result', text: 'CELESTE-742' })
    const archived = first.transcript.split('\n').flatMap(line => JSON.parse(line).model ?? []).filter(message => message.role !== 'system')
    expect(archived.map(message => message.role)).toEqual(['user', 'assistant'])
    const second = await runEmbeddedPi({ ...input, prompt: 'What was the code?', transcript: first.transcript }, {} as DurableObjectStorage)
    expect(second.result.type).toBe('result')
    expect(requests[1]?.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    const restored = second.transcript.split('\n').flatMap(line => JSON.parse(line).model ?? []).filter(message => message.role !== 'system')
    expect(restored.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})
