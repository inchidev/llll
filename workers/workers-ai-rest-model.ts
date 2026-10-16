import type { LanguageModel } from 'ai'
import {
  cloudflareAccountId,
  cloudflareApiToken,
  cloudflareErrorMessage,
  workersAiRunUrl,
  type CloudflareRestEnv,
} from './cloudflare-rest'

type PromptPart = { type?: string, text?: string, toolCallId?: string, toolName?: string, input?: unknown, output?: unknown }
type PromptMessage = { role: string, content: string | PromptPart[] }
type WorkersTool = {
  type?: string
  name?: string
  description?: string
  inputSchema?: unknown
}
type GenerateOptions = {
  prompt: PromptMessage[]
  tools?: WorkersTool[]
  maxOutputTokens?: number
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  name?: string
  tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>
}

const EMPTY_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

function parts(content: string | PromptPart[]): PromptPart[] {
  return Array.isArray(content) ? content : []
}

function textOf(content: string | PromptPart[]): string {
  if (typeof content === 'string') return content
  return parts(content).flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n')
}

function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value: unknown }).value
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }
  return JSON.stringify(output ?? null)
}

function promptToMessages(prompt: PromptMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: textOf(message.content) })
      continue
    }
    if (message.role === 'user') {
      messages.push({ role: 'user', content: textOf(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = parts(message.content).flatMap((part) => {
        if (part.type !== 'tool-call' || !part.toolName) return []
        const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {})
        return [{
          id: part.toolCallId || `call_${messages.length}`,
          type: 'function' as const,
          function: { name: part.toolName, arguments: input },
        }]
      })
      messages.push({
        role: 'assistant',
        content: textOf(message.content),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    if (message.role === 'tool') {
      for (const part of parts(message.content)) {
        if (part.type !== 'tool-result' || !part.toolCallId) continue
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          name: part.toolName,
          content: toolOutputText(part.output),
        })
      }
    }
  }
  return messages
}

function toolsBody(tools: WorkersTool[] | undefined) {
  const functions = (tools ?? []).filter(tool => tool.type === 'function' && tool.name)
  if (!functions.length) return undefined
  return functions.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function argumentString(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? {})
}

function parseToolCall(value: unknown, index: number): { type: 'tool-call', toolCallId: string, toolName: string, input: string } | null {
  const record = asRecord(value)
  if (!record) return null
  const fn = asRecord(record.function)
  const name = typeof fn?.name === 'string' ? fn.name : typeof record.name === 'string' ? record.name : ''
  if (!name) return null
  const args = fn && 'arguments' in fn ? fn.arguments : record.arguments
  const id = typeof record.id === 'string' && record.id ? record.id : `call_${index}`
  return { type: 'tool-call', toolCallId: id, toolName: name, input: argumentString(args) }
}

function parseResult(result: unknown): { text: string, toolCalls: Array<{ type: 'tool-call', toolCallId: string, toolName: string, input: string }> } {
  if (typeof result === 'string') return { text: result, toolCalls: [] }
  const record = asRecord(result)
  if (!record) return { text: '', toolCalls: [] }
  const choice = Array.isArray(record.choices) ? asRecord(record.choices[0]) : null
  const message = choice ? asRecord(choice.message) ?? choice : null
  const text = typeof record.response === 'string'
    ? record.response
    : message && typeof message.content === 'string'
      ? message.content
      : typeof record.content === 'string'
        ? record.content
        : ''
  const rawCalls = (message && message.tool_calls) || record.tool_calls
  const toolCalls = Array.isArray(rawCalls)
    ? rawCalls.flatMap((call, index) => {
        const parsed = parseToolCall(call, index)
        return parsed ? [parsed] : []
      })
    : []
  return { text, toolCalls }
}

/**
 * LanguageModel that POSTs chat messages to Workers AI REST.
 * A string model id would be resolved through the `AI` binding, which is absent here.
 */
export function workersAiRestModel(env: CloudflareRestEnv, modelId: string): LanguageModel {
  const resolvedAccountId = cloudflareAccountId(env)
  const resolvedToken = cloudflareApiToken(env)
  if (!resolvedAccountId || !resolvedToken) throw new Error('Cloudflare API credentials are missing')
  const accountId: string = resolvedAccountId
  const token: string = resolvedToken

  function finishReason(toolCalls: unknown[]) {
    return {
      unified: toolCalls.length ? 'tool-calls' as const : 'stop' as const,
      raw: undefined,
    }
  }

  async function doGenerate(options: GenerateOptions) {
    const tools = toolsBody(options.tools)
    const body = {
      messages: promptToMessages(options.prompt),
      ...(tools ? { tools } : {}),
      ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
    }
    let response: Response
    try {
      response = await fetch(workersAiRunUrl(accountId, modelId), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    }
    catch {
      throw new Error('Workers AI did not respond')
    }
    const payload = await response.json().catch(() => null) as { success?: boolean, result?: unknown } | null
    if (!response.ok || payload?.success === false) {
      throw new Error(cloudflareErrorMessage(payload, response.status, 'Workers AI'))
    }
    const parsed = parseResult(payload?.result ?? payload)
    if (!parsed.text && !parsed.toolCalls.length) throw new Error('Workers AI returned no text')
    const content = [
      ...(parsed.text ? [{ type: 'text' as const, text: parsed.text }] : []),
      ...parsed.toolCalls,
    ]
    return {
      content,
      finishReason: finishReason(parsed.toolCalls),
      usage: EMPTY_USAGE,
      warnings: [],
      request: { body },
      response: { body: payload },
    }
  }

  const model = {
    specificationVersion: 'v4' as const,
    provider: 'workers-ai-rest',
    modelId,
    supportedUrls: {} as Record<string, RegExp[]>,
    doGenerate,
    async doStream(options: GenerateOptions) {
      const result = await doGenerate(options)
      const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: result.warnings }]
      for (const part of result.content) {
        if (part.type === 'text') {
          const id = 'text-0'
          chunks.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: part.text }, { type: 'text-end', id })
        }
        else {
          chunks.push(
            { type: 'tool-input-start', id: part.toolCallId, toolName: part.toolName },
            { type: 'tool-input-delta', id: part.toolCallId, delta: part.input },
            { type: 'tool-input-end', id: part.toolCallId },
            part,
          )
        }
      }
      chunks.push({ type: 'finish', usage: result.usage, finishReason: result.finishReason })
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
        request: result.request,
      }
    },
  }
  return model as LanguageModel
}
