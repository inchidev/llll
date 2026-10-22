/**
 * Experimental embedded Pi executor: the agent harness runs inside the SQLite
 * Durable Object itself, with no container and no Node process. Storage is the
 * official pi-durable Durable Object SQLite adapter, so commits are DO storage
 * transactions and a dead attempt resumes from the last committed step.
 * Shell and computer tools are unavailable by design (there is no filesystem).
 */
import { Harness, createRegistry, type AssistantEntry } from '@earendil-works/pi-durable'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { RuntimeEvent } from '../shared/agent-execution'

export interface EmbeddedPiSubmission {
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

export async function runEmbeddedPi(input: EmbeddedPiSubmission, storage: DurableObjectStorage): Promise<EmbeddedPiOutcome> {
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
      contextWindow: 64000,
      maxTokens: 4096,
    }],
    api: openAICompletionsApi(),
  }))

  const storageImplementation = await openDurableObjectSqliteStorage(storage as never)
  const harness = await Harness.open(storageImplementation, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
  const transcriptLines: string[] = String(input.transcript ?? '').split('\n').filter(Boolean)
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'l4', modelId: input.modelGateway.model }, instructions: input.instructions },
    } as never)
    // Seed the prior conversation so the model context continues across attempts.
    for (const line of transcriptLines.slice(-200)) {
      try {
        const prior = JSON.parse(line) as { kind?: string, model?: unknown }
        if (prior?.kind) await conversation.submit({ type: 'write', entry: { kind: prior.kind, model: prior.model } } as never, BACKGROUND_CONTEXT)
      } catch { /* Tolerate malformed transcript lines. */ }
    }
    const submission = await conversation.submit({ type: 'input', content: input.prompt } as never, BACKGROUND_CONTEXT)
    const settled: unknown = await (submission as unknown as { wait(context: Context): Promise<unknown> }).wait(BACKGROUND_CONTEXT)
    const record = (settled && typeof settled === 'object' ? settled : {}) as Record<string, unknown>
    if (record.status === 'done') {
      // The settled record carries the answer only as an EntryId; read it from the transcript.
      const page = await (conversation as unknown as {
        entries: (query: unknown, limit: number, cursor: undefined, context: Context) => Promise<{ items: readonly unknown[] }>
      }).entries({ order: 'descending' }, 5, undefined, BACKGROUND_CONTEXT)
      const answerId = record.answer
      const items = page.items as Array<{ id?: unknown, kind?: string, model?: unknown }>
      const chosen = items.find(item => item.id === answerId)
      const text = assistantText(chosen ? [chosen] : undefined)
      const event: RuntimeEvent = text
        ? { type: 'result', text, steps: 1 }
        : { type: 'error', message: `Embedded Pi answered without text (kinds: ${items.map(item => item.kind).join(',').slice(0, 120)})` }
      // The transcript chain: seeded prior lines plus this conversation's own entries.
      const answerNumber = typeof answerId === 'number' ? answerId : Number(answerId) || Infinity
      const ownEntries: string[] = []
      for (const item of items) {
        if (typeof item.id !== 'number' || item.id > answerNumber) continue
        ownEntries.push(JSON.stringify({ kind: item.kind, model: item.model ?? [] }))
      }
      const nextTranscript = [...transcriptLines, ...ownEntries].join('\n').slice(0, 1_900_000)
      return { events: [], result: event, transcript: nextTranscript }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Embedded Pi failed'
    return { events: [], result: { type: 'error', message: message.slice(0, 500) } }
  } finally {
    try { await harness.close(BACKGROUND_CONTEXT) } catch { /* the storage commits survive closure. */ }
  }
}

export type { AssistantEntry }
