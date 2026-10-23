import { streamText, jsonSchema, tool, type ModelMessage } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import { findAgentRun, runAuthorization, verifyRunCapability } from './agent-run-service'
import { executeRunTool } from './agent-tools'
import { runtimeFiles } from './agent-files'
import { codeRepositoryArchive } from './agent-code-service'
import type { L4Env } from '../../workers/env'
import { modelForRun } from '../../workers/ai-runtime'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import type { AgentRun, RunMandate } from '../../shared/agent-execution'

const modelRequest = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.unknown().optional(),
    tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() })).max(2000),
  tools: z.array(z.object({ function: z.object({ name: z.string().max(64), description: z.string().max(2000).optional(), parameters: z.record(z.string(), z.unknown()) }) })).max(40).optional(),
  stream: z.boolean().optional(),
})

function messagesForModel(input: z.infer<typeof modelRequest>['messages']): ModelMessage[] {
  const toolNames = new Map(input.flatMap(message => (message.tool_calls ?? []).map(call => [call.id, call.function.name] as const)))
  return input.map(message => {
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.map((part: unknown) => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('\n') : ''
    if (message.role === 'tool') return { role: 'tool', content: [{ type: 'tool-result', toolCallId: message.tool_call_id || '', toolName: toolNames.get(message.tool_call_id || '') || 'unknown', output: { type: 'text', value: text } }] }
    if (message.role === 'assistant') return { role: 'assistant', content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(message.tool_calls ?? []).map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.function.name, input: JSON.parse(call.function.arguments) })),
    ] }
    return { role: message.role, content: text }
  })
}

async function modelResponse(env: L4Env, run: AgentRun, input: z.infer<typeof modelRequest>, signal: AbortSignal): Promise<Response> {
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  const maxOutputTokens = 4096
  // Conservative reservation includes input bytes, output allowance and protocol overhead.
  const reservation = new TextEncoder().encode(JSON.stringify(input)).byteLength + maxOutputTokens + 2048
  const admitted = await env.DB.prepare(`UPDATE agent_runs SET model_calls=model_calls+1,total_tokens=total_tokens+? WHERE id=? AND status='running'
    AND model_calls<? AND total_tokens+?<=?
    AND (SELECT COALESCE(SUM(total_tokens),0) FROM agent_runs WHERE agent_id=? AND created_at>=?)+?<=250000 RETURNING id`).bind(reservation, run.id, mandate.maxModelCalls, reservation, mandate.maxTokens, run.agentId, new Date(Date.now()-86400000).toISOString(), reservation).first()
  if (!admitted) return Response.json({ error: { message: 'Run inference budget exhausted' } }, { status: 429 })
  const resolved = await modelForRun(env, run.model, run.sessionId, run.initiatedBy)
  const model = typeof resolved === 'string' && env.AI ? createWorkersAI({ binding: env.AI })(resolved) : resolved
  if (typeof model === 'string') return Response.json({ error: { message: 'Model provider unavailable' } }, { status: 503 })
  const tools = Object.fromEntries((input.tools ?? []).map(definition => [definition.function.name, tool({
    description: definition.function.description, inputSchema: jsonSchema(definition.function.parameters),
  })]))
  const instructions = input.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : '').join('\n')
  const settings = { model, instructions, messages: messagesForModel(input.messages.filter(message => message.role !== 'system')), tools, maxOutputTokens,
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Date.parse(run.deadline) - Date.now()))]) }
  if (input.stream) {
    const abort = new AbortController()
    const result = streamText({ ...settings, abortSignal: AbortSignal.any([settings.abortSignal, abort.signal]) })
    const encoder = new TextEncoder()
    const id = `l4-${run.id}-${run.modelCalls + 1}`
    const created = Math.floor(Date.now() / 1000)
    let callIndex = 0
    const chunk = (delta: unknown, finish: string | null = null) => encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: run.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const iterator = result.fullStream[Symbol.asyncIterator]()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done) {
              const usage = await result.totalUsage
              await env.DB.prepare('UPDATE agent_runs SET total_tokens=MAX(0,total_tokens+?) WHERE id=?').bind((usage.totalTokens ?? reservation) - reservation, run.id).run()
              controller.enqueue(chunk({}, callIndex ? 'tool_calls' : 'stop'))
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: run.model, choices: [], usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: usage.totalTokens ?? 0 } })}\n\ndata: [DONE]\n\n`))
              controller.close()
              return
            }
            const part = next.value
            if (part.type === 'error' || part.type === 'abort') throw new Error('Inference interrupted')
            if (part.type === 'text-delta') { controller.enqueue(chunk({ content: part.text })); return }
            if (part.type === 'tool-call') {
              controller.enqueue(chunk({ tool_calls: [{ index: callIndex++, id: part.toolCallId, type: 'function', function: { name: part.toolName, arguments: JSON.stringify(part.input) } }] }))
              return
            }
          }
        } catch { abort.abort(); controller.error(new Error('Inference stream interrupted')) }
      },
      async cancel() { abort.abort(); await iterator.return?.() },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }
  const streamed = streamText(settings)
  const [text, usage, toolCalls] = await Promise.all([streamed.text, streamed.totalUsage, streamed.toolCalls])
  const result = { text, usage, toolCalls }
  const used = result.usage.totalTokens ?? reservation
  // Never refund more than the reserved amount, and keep unexpected provider overruns visible.
  await env.DB.prepare('UPDATE agent_runs SET total_tokens=MAX(0,total_tokens+?) WHERE id=?').bind(used - reservation, run.id).run()
  const calls = result.toolCalls.map(call => ({ id: call.toolCallId, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.input) } }))
  const id = `l4-${run.id}-${run.modelCalls + 1}`
  const created = Math.floor(Date.now() / 1000)
  return Response.json({ id, object: 'chat.completion', created, model: run.model, choices: [{ index: 0,
    message: { role: 'assistant', content: result.text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
  usage: { total_tokens: used } })

}

export async function agentGateway(request: Request, env: L4Env, runId: string, operation: string, schedule: (promise: Promise<unknown>) => void): Promise<Response> {
  const capability = request.headers.get('Authorization')?.replace(/^Bearer /u, '') || ''
  if (!await verifyRunCapability(env, runId, capability)) return new Response('Unauthorized', { status: 401 })
  const run = await findAgentRun(env, runId)
  if (!run || run.status !== 'running' || run.deadline <= new Date().toISOString()) return new Response('Run is no longer active', { status: 403 })
  if (request.method === 'GET' && operation === 'files') {
    try { return await runtimeFiles(env, run) } catch { return new Response('Files unavailable', { status: 403 }) }
  }
  if (request.method === 'GET' && operation === 'repository/archive') {
    try { await runAuthorization(env, run); return await codeRepositoryArchive(env, run.id) }
    catch { return new Response('Repository archive is unavailable under the current mandate', { status: 403 }) }
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const body = await readLimitedStream(request.body, 256000)
  if (!body.ok) return new Response('Invalid request size', { status: 413 })
  try {
    const authorization = await runAuthorization(env, run)
    const input: unknown = JSON.parse(new TextDecoder().decode(body.bytes))
    if (operation === 'v1/chat/completions') return await modelResponse(env, run, modelRequest.parse(input), request.signal)
    if (operation === 'tools') {
      const call = z.object({ callId: z.string().min(1).max(200), name: z.string().min(1).max(64), arguments: z.unknown() }).parse(input)
      return Response.json(await executeRunTool(env, run.id, authorization, call, schedule, request.signal))
    }
    return new Response('Unknown operation', { status: 404 })
  } catch (error) {
    // Upstream exceptions may contain provider headers; never forward them to untrusted compute.
    console.warn('agent.gateway.failed', { runId, operation, errorType: error instanceof Error ? error.name : 'Unknown' })
    const code = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 502
    return Response.json({ error: { message: code === 403 ? 'Current permissions do not allow this operation' : 'The operation failed; inspect the Run before retrying' } }, { status: code })
  }
}
