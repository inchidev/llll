import { afterEach, describe, expect, it, vi } from 'vitest'
import { embeddedPiFailure, runEmbeddedPi } from '../../workers/agent-pi-durable'

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

it('waits for one exact factory action using a stable call identity before continuing the model', async () => {
  const calls: Array<{ callId: string; name: string; arguments: unknown }> = []
  let turns = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/tools')) {
      calls.push(body)
      return Response.json(calls.length === 1 ? { factoryPending: true, status: 'pending', actionId: 'approved-once' } : { ok: true, output: 'Pinned checkout' })
    }
    turns++
    return turns === 1 ? streamAnswer({ role: 'assistant', tool_calls: [{ index: 0, id: 'factory-once', type: 'function', function: { name: 'factory_workspace', arguments: '{"operation":"bootstrap"}' } }] }, 'tool_calls') : streamAnswer({ role: 'assistant', content: 'The approved workspace is ready.' })
  }))
  const result = await runEmbeddedPi({ ...input, toolEndpoint: 'https://fixture.invalid/tools', tools: [{ name: 'factory_workspace', description: 'Request an exactly reviewed workspace action', parameters: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] } }] }, {} as DurableObjectStorage)
  expect(result.result).toMatchObject({ type: 'result', text: 'The approved workspace is ready.' })
  expect(calls).toHaveLength(2)
  expect(calls[0]?.callId).toBe(calls[1]?.callId)
  expect(calls[0]?.arguments).toEqual(calls[1]?.arguments)
  expect(turns).toBe(2)
})

it('loads one deferred schema after Server discovery, then executes it through the same gateway', async () => {
  let turn = 0
  const events: unknown[] = []
  const called: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/tools')) {
      called.push(body.name)
      if (body.arguments?.name === 'unselected_tool') return Response.json({ error: 'Unavailable' }, { status: 403 })
      return Response.json(body.name === 'get_tool_details' ? { tool: { name: 'list_tasks' }, purpose: 'Find accessible work' } : { boards: [{ name: 'Allowed board' }] })
    }
    const names = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
    if (++turn <= 2) {
      expect(names).toEqual(['get_tool_details'])
      expect(JSON.stringify(body)).not.toContain('privateSchemaMarker')
      if (turn === 2) expect(JSON.stringify(body.messages)).toContain('403')
      return streamAnswer({ role: 'assistant', tool_calls: [{ index: 0, id: `load-${turn}`, type: 'function', function: { name: 'get_tool_details', arguments: JSON.stringify({ name: turn === 1 ? 'unselected_tool' : 'list_tasks', purpose: 'Find accessible work' }) } }] }, 'tool_calls')
    }
    expect(names).toContain('list_tasks')
    expect(names).not.toContain('unselected_tool')
    if (turn === 3) return streamAnswer({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-one', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] }, 'tool_calls')
    return streamAnswer({ role: 'assistant', content: 'Found accessible work.' })
  }))
  const outcome = await runEmbeddedPi({ ...input, runId: 'discovery-run', toolEndpoint: 'https://fixture.invalid/tools', tools: [
    { name: 'get_tool_details', description: 'Load one tool', parameters: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' } }, required: ['name', 'purpose'] } },
    { name: 'list_tasks', description: 'Read permitted tasks', parameters: { type: 'object', properties: {} }, deferred: true },
    { name: 'unselected_tool', description: 'Unused', parameters: { type: 'object', properties: { privateSchemaMarker: { type: 'string' } } }, deferred: true },
  ] }, {} as DurableObjectStorage, { event: async event => { events.push(event) } })
  expect(outcome.result).toMatchObject({ type: 'result', text: 'Found accessible work.' })
  expect(called).toEqual(['get_tool_details', 'get_tool_details', 'list_tasks'])
  expect(events).toContainEqual({ type: 'tool', name: 'list_tasks', purpose: 'Find accessible work' })
})

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

it('settles a local budget refusal after one provider attempt without transient-rate-limit retries', async () => {
  const network = vi.fn(async () => Response.json({ error: { code: 'agent_daily_token_budget', message: 'The rolling 24-hour token budget cannot fit the reserved request.' } }, { status: 400 }))
  vi.stubGlobal('fetch', network)
  const outcome = await runEmbeddedPi(input, {} as DurableObjectStorage)
  expect(outcome.result.type).toBe('error')
  expect(network).toHaveBeenCalledTimes(1)
})

it.each([
  ['aborted', undefined, 'interrupted'],
  ['stale', 'secret-token private prompt', 'conversation changed'],
  ['reset', undefined, 'conversation changed'],
  ['no_model', undefined, 'selected model'],
  ['faulted', 'secret-token private prompt', 'could not finish'],
  ['model_error', '429 secret-token private prompt', 'rate limit'],
  ['model_error', '401 secret-token private prompt', 'rejected access'],
  ['model_error', 'unknown failure secret-token private prompt', 'provider connection'],
] as const)('classifies %s without exposing raw details', (reason, detail, expected) => {
  const message = embeddedPiFailure({ reason, detail })
  expect(message).toContain(expected)
  expect(message).not.toMatch(/secret-token|private prompt|unanswered/)
})

it('finishes alarm-driven steering at a held tool boundary after a transient provider failure', async () => {
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const toolStarted = new Promise<void>(resolve => { reached = resolve })
  let steer!: (id: string, content: string) => Promise<void>
  let resume: (() => void) | undefined
  let requests = 0, toolCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/tools')) { toolCalls++; reached(); await held; return Response.json({ text: 'untrusted source evidence '.repeat(500) }) }
    const body = JSON.parse(String(init.body))
    requests++
    if (requests === 1) return streamAnswer({ role: 'assistant', tool_calls: [{ index: 0, id: 'held-search', type: 'function', function: { name: 'search_web', arguments: '{}' } }] }, 'tool_calls')
    if (requests === 2) return Response.json({ error: { message: 'Temporary rate limit' } }, { status: 429 })
    expect(body.messages.filter((m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Stop searching and answer STEER_RETRY_OK'))).toHaveLength(1)
    return streamAnswer({ role: 'assistant', content: 'STEER_RETRY_OK' })
  }))
  const timer = setInterval(() => resume?.(), 25)
  try {
    const generation = runEmbeddedPi({ ...input, runId: 'alarm-steer-retry', toolEndpoint: 'https://fixture.invalid/tools', tools: [{ name: 'search_web', description: 'Read external sources', parameters: { type: 'object', properties: {} } }] }, {} as DurableObjectStorage, {
      alarmDriven: true, signal: AbortSignal.timeout(8000), ready: async (control, wake) => { steer = control; resume = wake },
    })
    await toolStarted
    await steer('steer-once', 'Stop searching and answer STEER_RETRY_OK')
    await steer('steer-once', 'Stop searching and answer STEER_RETRY_OK')
    release()
    const outcome = await generation
    expect(outcome.result).toMatchObject({ type: 'result', text: 'STEER_RETRY_OK' })
    expect(requests).toBe(3)
    expect(toolCalls).toBe(1)
  } finally { release(); clearInterval(timer) }
}, 10000)
