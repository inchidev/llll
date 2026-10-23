/** Adapt AI SDK Responses requests to the public ChatGPT-plan route. No private backend endpoints. */
export const chatGPTFetch: typeof fetch = async (input, init) => {
  const raw = JSON.parse(String(init?.body)) as Record<string, unknown>
  const unsupported = new Set(['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'])
  const body = Object.fromEntries(Object.entries(raw).filter(([key]) => !unsupported.has(key)))
  body.store = false; body.stream = true
  const tools = body.tools as Array<{ type: string }> | undefined
  if (tools?.some(t => t.type === 'function')) body.tools = [{ type: 'namespace', name: 'l4', description: 'Tools authorized by this L4 Server', tools: tools.filter(t => t.type === 'function') }, ...tools.filter(t => t.type !== 'function')]
  if (Array.isArray(body.input)) body.input = body.input.map(item => item.type === 'function_call' && !item.namespace ? { ...item, namespace: 'l4' } : item.role === 'system' ? { ...item, role: 'developer' } : item)
  const response = await globalThis.fetch(input, { ...init, body: JSON.stringify(body), redirect: 'error' })
  if (!response.ok || !response.body) return response
  let completed = false, pending = ''
  const decoder = new TextDecoder()
  const checked = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      if (pending.length > 2000000) throw new Error('ChatGPT event exceeded the limit')
      const lines = pending.split('\n'); pending = lines.pop()!
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        const event = JSON.parse(data) as { type?: string }
        if (event.type === 'response.completed') completed = true
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw new Error('ChatGPT did not complete the response')
      }
      controller.enqueue(chunk)
    },
    flush() { if (!completed) throw new Error('ChatGPT stream ended before response.completed') },
  }))
  return new Response(checked, { status: response.status, headers: response.headers })
}
