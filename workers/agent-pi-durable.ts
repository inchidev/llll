import { inferenceFailure } from '../server/utils/agent-inference-errors'
/** Embedded Pi runs in the Run's SQLite Durable Object; provider secrets stay at the gateway. */
import { Harness, createRegistry, watchEvents, type AssistantEntry, type ToolRegistration } from '@earendil-works/pi-durable'
import { readLimitedStream } from './inbound-email-signature'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { RuntimeEvent, RuntimeTool } from '../shared/agent-execution'

export interface EmbeddedPiSubmission {
  runId?: string
  steering?: Array<{ messageId: string; content: string }>
  tools?: RuntimeTool[]
  toolEndpoint?: string
  prompt: string
  instructions: string
  modelGateway: { url: string, token: string, model: string }
  /** JSONL transcript from earlier attempts; each line: { kind, model: Message[] }. */
  transcript?: string | null
}

export interface EmbeddedPiOutcome {
  events: RuntimeEvent[]
  result: RuntimeEvent
  /** The transcript chain for this run: prior lines plus this run's entries. */
  transcript: string
}

/** Assistant text only: pi-ai Message records carry content string or text/tool blocks. */
function assistantText(items: ReadonlyArray<{ kind?: string, model?: unknown }> | undefined): string {
  const parts: string[] = []
  for (const record of items ?? []) {
    const messages = Array.isArray(record.model) ? record.model as Array<Record<string, unknown>> : []
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const content = message.content
      if (typeof content === 'string') { if (content.trim()) parts.push(content); continue }
      if (Array.isArray(content)) {
        const text = content.filter((block): block is { type: 'text', text: string } => block?.type === 'text')
          .map(block => block.text.trim()).filter(Boolean).join('\n')
        if (text) parts.push(text)
      }
    }
  }
  return parts.join('\n\n')
}

/** Never copy provider details: they can contain credentials, prompts or tool output. */
export function embeddedPiFailure(record: { reason?: string; detail?: unknown }): string {
  if (record.reason === 'model_error') {
    const detail = typeof record.detail === 'string' ? record.detail : ''
    const status = /^(?:Error: )?(400|401|403|404|409|422|429|5\d\d)\b/u.exec(detail)?.[1]
    return inferenceFailure(detail ? { message: detail, ...(status ? { status: Number(status) } : {}) } : record.detail)
  }
  if (record.reason === 'no_model') return 'The selected model is unavailable to Pi. Check the provider and model configuration before retrying.'
  if (record.reason === 'aborted') return 'Embedded Pi execution was interrupted. Review completed tool calls before starting another attempt.'
  if (record.reason === 'reset' || record.reason === 'stale') return 'The conversation changed before Pi could answer. Review its latest messages before starting another attempt.'
  return 'Embedded Pi could not finish this submission. Review completed tool calls before starting another attempt.'
}

export async function runEmbeddedPi(input: EmbeddedPiSubmission, storage: DurableObjectStorage, host: {
  signal?: AbortSignal
  event?: (event: RuntimeEvent) => Promise<void>
  ready?: (steer: (messageId: string, content: string) => Promise<void>, resume: () => void) => Promise<void>
  /** A host with alarms drives sleeping tasks through resume instead of process timers. */
  alarmDriven?: boolean
  /** Reaches the model and tool gateway; the host may serve it without a network round trip. */
  fetch?: typeof fetch
} = {}): Promise<EmbeddedPiOutcome> {
  const gatewayFetch = host.fetch ?? fetch
  const completions = openAICompletionsApi()
  const models = createModels()
  models.setProvider(createProvider({
    id: 'l4',
    name: 'L4 model gateway',
    baseUrl: input.modelGateway.url,
    auth: {
      apiKey: {
        name: 'L4 gateway capability',
        resolve: async () => ({ auth: { apiKey: input.modelGateway.token } }),
      },
    },
    models: [{
      id: input.modelGateway.model,
      name: input.modelGateway.model,
      api: 'openai-completions',
      provider: 'l4',
      baseUrl: input.modelGateway.url,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 24000,
      maxTokens: 4096,
    }],
    api: {
      ...completions,
      stream: (model, context, options) => completions.stream(model, context, { ...options, fetch: gatewayFetch }),
      streamSimple: (model, context, options) => completions.streamSimple(model, context, { ...options, fetch: gatewayFetch }),
    },
  }))

  const events: RuntimeEvent[] = []
  const storageImplementation = await openDurableObjectSqliteStorage(storage as never)
  const tools: ToolRegistration[] = (input.tools ?? []).map(definition => ({
    name: definition.name, description: definition.description, parameters: definition.parameters as ToolRegistration['parameters'],
    ...(definition.deferred ? { deferred: true as const } : {}),
    // The gateway persists each call's result by stable ID and refuses uncertain writes.
    replay: 'safe', executionMode: 'sequential',
    async execute(args, api, context) {
      if (!input.toolEndpoint) throw new Error('Tool gateway unavailable')
      let output: string
      for (;;) {
        const response = await gatewayFetch(input.toolEndpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.modelGateway.token}` },
        body: JSON.stringify({ callId: api.callId, name: definition.name, arguments: args }),
        signal: AbortSignal.any([...(context.abortSignal ? [context.abortSignal] : []), ...(host.signal ? [host.signal] : []), AbortSignal.timeout(60000)]),
      })
      const body = await readLimitedStream(response.body, 500000)
      if (!body.ok) throw new Error('Tool output exceeds its limit')
        output = new TextDecoder().decode(body.bytes)
      if (!response.ok) {
        let message = `Tool gateway rejected the operation (${response.status})`
        // Only this Server-owned validation diagnostic is safe to return to the model.
        if (response.status === 400) {
          try { const detail = JSON.parse(output).error?.message; if (typeof detail === 'string' && detail.startsWith('Invalid tool arguments: ')) message = detail.slice(0, 500) } catch { /* Generic error below. */ }
        }
        throw new Error(message)
      }

        const progress = JSON.parse(output) as { factoryPending?: boolean; delegationPending?: boolean }
        if (!(definition.name === 'factory_workspace' && progress.factoryPending === true) && !(definition.name === 'delegate_task' && progress.delegationPending === true)) break
        await new Promise<void>((resolve, reject) => {
          const signal = context.abortSignal ?? host.signal
          if (signal?.aborted) { reject(new Error('Run cancelled')); return }
          const stop = () => { clearTimeout(timer); reject(new Error('Run cancelled')) }
          const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, 2000)
          signal?.addEventListener('abort', stop, { once: true })
        })
      }
      if (definition.name === 'get_tool_details') {
        const result = JSON.parse(output) as { tool?: { name?: string }; purpose?: string }
        const selected = tools.find(tool => tool.name === result.tool?.name && tool.deferred)
        if (selected) {
          const event: RuntimeEvent = { type: 'tool', name: selected.name, purpose: typeof result.purpose === 'string' ? result.purpose.slice(0, 240) : undefined }
          if (events.length < 2000) { events.push(event); await host.event?.(event) }
          return { output: [{ type: 'text', text: output }], control: { addTools: [selected.name] } }
        }
      }
      return { output: [{ type: 'text', text: output }] }
    },
  }))
  const registry = createRegistry()
  registry.install({ name: 'l4', tools })
  const harness = await Harness.open(storageImplementation, { models, registry, settings: { compaction: { reserveTokens: 4096, keepRecentTokens: 6000 } }, ...(host.alarmDriven ? { onWake: () => undefined } : {}) }, BACKGROUND_CONTEXT)
  const transcriptLines: string[] = String(input.transcript ?? '').split('\n').filter(Boolean)
  let cancel: (() => void) | undefined
  let stream: Awaited<ReturnType<typeof watchEvents>> | undefined
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'l4', modelId: input.modelGateway.model }, instructions: input.instructions, tools },
    })
    let priorAssistantEntries = 0
    // Seed the prior conversation so the model context continues across attempts.
    for (const [index, line] of transcriptLines.entries()) {
      try {
        const prior = JSON.parse(line) as { kind?: string, model?: unknown }
        if (prior.kind === 'pi.assistant') priorAssistantEntries++
        if (prior?.kind) await conversation.submit({ type: 'write', requestId: `history:${index}`, entry: { kind: prior.kind, model: prior.model } } as never, BACKGROUND_CONTEXT)
      } catch { /* Tolerate malformed transcript lines. */ }
    }
    stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT)
    let streamedText = false
    stream.start(async batch => {
      for (const event of batch) {
        if (event.type === 'message_start') streamedText = false
        const next: RuntimeEvent[] = event.type === 'tool_execution_start' ? [{ type: 'tool', name: event.toolName }]
          : event.type === 'message_update' ? [{ type: 'text' as const, text: event.changes.map(change => change.type === 'text_delta' ? change.delta : '').join('') }].filter(item => item.text)
            : event.type === 'message_end' && !streamedText && assistantText([event.entry]) ? [{ type: 'text', text: assistantText([event.entry]) }] : []
        if (next.some(item => item.type === 'text')) streamedText = true
        for (const item of next) {
          // The host persists a bounded event log; transcript storage remains authoritative.
          if (events.length < 2000) { events.push(item); await host.event?.(item) }
        }
      }
    })
    const submission = await conversation.submit({ type: 'input', requestId: input.runId ?? 'input', content: input.prompt }, BACKGROUND_CONTEXT)
    const steer = async (messageId: string, content: string) => {
      await conversation.submit({ type: 'input', content, requestId: `steer:${messageId}`, whenBusy: 'steer' }, BACKGROUND_CONTEXT)
    }
    for (const message of input.steering ?? []) await steer(message.messageId, message.content)
    await host.ready?.(steer, () => harness.resume())
    cancel = () => { void conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined) }
    host.signal?.addEventListener('abort', cancel, { once: true })
    if (host.signal?.aborted) cancel()
    harness.resume()
    const record = await submission.wait(BACKGROUND_CONTEXT)
    if (record.status === 'done') {
      // The active context is chronological and includes seeded history exactly once.
      // Reading only the five newest entries reversed and duplicated older context.
      const view = await conversation.context(BACKGROUND_CONTEXT)
      const answerId = record.answer
      const items = view.entries
      const chosen = items.find(item => item.id === answerId)
      const text = assistantText(chosen ? [chosen] : undefined)
      const event: RuntimeEvent = text
        ? { type: 'result', text, steps: Math.max(1, items.filter(item => item.kind === 'pi.assistant').length - priorAssistantEntries) }
        : { type: 'error', message: `Embedded Pi answered without text (kinds: ${items.map(item => item.kind).join(',').slice(0, 120)})` }
      const nextTranscript = view.entries.map((item, index) => ({
        kind: item.kind,
        // Instructions are rebuilt from current authorization, never restored from an old Run.
        model: view.contributions[index]!.filter(message => message.role !== 'system'),
      })).filter(item => item.model.length).map(item => JSON.stringify(item)).join('\n')
      if (new TextEncoder().encode(nextTranscript).length > 1_900_000) throw new Error('Embedded Pi session archive exceeds its limit')
      return { events, result: event, transcript: nextTranscript }
    }
    return { events, result: { type: 'error', message: embeddedPiFailure(record) }, transcript: input.transcript ?? '' }
  } catch (error) {
    const known = error instanceof Error ? error.message : ''
    const message = ['Embedded Pi session archive exceeds its limit', 'Tool output exceeds its limit', 'Tool gateway unavailable'].includes(known)
      ? known : inferenceFailure(error)
    return { events, result: { type: 'error', message: message.slice(0, 500) }, transcript: input.transcript ?? '' }
  } finally {
    if (cancel) host.signal?.removeEventListener('abort', cancel)
    await stream?.stop()
    try { await harness.close(BACKGROUND_CONTEXT) } catch { /* the storage commits survive closure. */ }
  }
}

export type { AssistantEntry }
