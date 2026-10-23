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

function streamAnswer(delta: Record<string, unknown>, finish = 'stop') {
  const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  return new Response(frame(delta, null) + frame({}, finish) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

it('executes a model-requested L4 tool with its stable call ID and capability, then continues', async () => {
  const calls: unknown[] = []
  let modelCalls = 0
  const events: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/tools')) {
      calls.push({ ...body, authorization: new Headers(init.headers).get('Authorization') })
      return Response.json({ boards: [{ name: 'Allowed board' }] })
    }
    modelCalls++
    if (modelCalls === 1) {
      expect(body.tools[0].function.name).toBe('list_tasks')
      return streamAnswer({ role: 'assistant', tool_calls: [{ index: 0, id: 'stable-call-1', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] }, 'tool_calls')
    }
    expect(body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('Allowed board'))).toBe(true)
    return streamAnswer({ role: 'assistant', content: 'Found the allowed board.' })
  }))
  const outcome = await runEmbeddedPi({ ...input, runId: 'run-tools', toolEndpoint: 'https://fixture.invalid/tools', tools: [{ name: 'list_tasks', description: 'Read tasks', parameters: { type: 'object', properties: {} } }] }, {} as DurableObjectStorage, { event: async event => { events.push(event) } })
  expect(outcome.result).toMatchObject({ type: 'result', text: 'Found the allowed board.' })
  expect(calls).toEqual([{ callId: 'stable-call-1', name: 'list_tasks', arguments: {}, authorization: 'Bearer test-capability' }])
  expect(events).toContainEqual({ type: 'tool', name: 'list_tasks' })
  expect(events.some((event: unknown) => (event as { type: string }).type === 'text')).toBe(true)
})

it('Stop aborts the in-flight provider request and settles the harness', async () => {
  const stop = new AbortController()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    started()
    await new Promise<void>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')) }, { once: true })
    })
    return streamAnswer({})
  }))
  const generation = runEmbeddedPi({ ...input, runId: 'run-stop' }, {} as DurableObjectStorage, { signal: stop.signal })
  await ready
  stop.abort()
  const outcome = await generation
  expect(aborted).toBe(true)
  expect(outcome.result.type).toBe('error')
})

it('places steering instructions at the tool boundary and deduplicates a delivered message', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const toolStarted = new Promise<void>(resolve => { reached = resolve })
  let controls!: (messageId: string, content: string) => Promise<void>
  let ready!: () => void
  const hostReady = new Promise<void>(resolve => { ready = resolve })
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/tools')) { reached(); await held; return Response.json({ found: true }) }
    const body = JSON.parse(String(init.body))
    if (++requests === 1) return streamAnswer({ role: 'assistant', tool_calls: [{ index: 0, id: 'boundary-tool', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] }, 'tool_calls')
    expect(body.messages.filter((message: { role: string; content: string }) => message.role === 'user' && message.content.includes('Now summarize only'))).toHaveLength(1)
    return streamAnswer({ role: 'assistant', content: 'Steered answer' })
  }))
  const generation = runEmbeddedPi({ ...input, runId: 'steered-run', toolEndpoint: 'https://fixture.invalid/tools', tools: [{ name: 'list_tasks', description: 'Read tasks', parameters: { type: 'object', properties: {} } }] }, {} as DurableObjectStorage, { ready: async steer => { controls = steer; ready() } })
  await Promise.all([toolStarted, hostReady])
  await controls('message-1', 'Now summarize only')
  await controls('message-1', 'Now summarize only')
  release()
  expect((await generation).result).toMatchObject({ type: 'result', text: 'Steered answer' })
})
