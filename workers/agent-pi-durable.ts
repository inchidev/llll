/**
 * Experimental embedded Pi executor: the agent harness runs inside the SQLite
 * Durable Object itself, with no container and no Node process. Storage is the
 * official pi-durable Durable Object SQLite adapter. The host currently starts
 * the harness only on submission; reopening active work after eviction is not
 * implemented by the coordinator yet.
 * Shell and computer tools are unavailable by design (there is no filesystem).
 */
import { Harness, createRegistry, type AssistantEntry } from '@earendil-works/pi-durable'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
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
    })
    // Seed the prior conversation so the model context continues across attempts.
    for (const line of transcriptLines) {
      try {
        const prior = JSON.parse(line) as { kind?: string, model?: unknown }
        if (prior?.kind) await conversation.submit({ type: 'write', entry: { kind: prior.kind, model: prior.model } } as never, BACKGROUND_CONTEXT)
      } catch { /* Tolerate malformed transcript lines. */ }
    }
    const submission = await conversation.submit({ type: 'input', content: input.prompt }, BACKGROUND_CONTEXT)
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
        ? { type: 'result', text, steps: 1 }
        : { type: 'error', message: `Embedded Pi answered without text (kinds: ${items.map(item => item.kind).join(',').slice(0, 120)})` }
      const nextTranscript = view.entries.map((item, index) => ({
        kind: item.kind,
        // Instructions are rebuilt from current authorization, never restored from an old Run.
        model: view.contributions[index]!.filter(message => message.role !== 'system'),
      })).filter(item => item.model.length).map(item => JSON.stringify(item)).join('\n')
      if (new TextEncoder().encode(nextTranscript).length > 1_900_000) throw new Error('Embedded Pi session archive exceeds its limit')
      return { events: [], result: event, transcript: nextTranscript }
    }
    return { events: [], result: { type: 'error', message: `Embedded Pi submission ended with status ${record.status}` }, transcript: input.transcript ?? '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Embedded Pi failed'
    return { events: [], result: { type: 'error', message: message.slice(0, 500) }, transcript: input.transcript ?? '' }
  } finally {
    try { await harness.close(BACKGROUND_CONTEXT) } catch { /* the storage commits survive closure. */ }
  }
}

export type { AssistantEntry }
