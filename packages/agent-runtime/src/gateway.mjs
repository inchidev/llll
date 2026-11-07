/** The Server gateway a Run's executor talks to, with the Run's capability; no other credential is used. */

/** Another operation of the same Run's gateway, next to its tools endpoint. */
export function gatewayUrl(input, operation) {
  const url = new URL(input.toolEndpoint)
  if (!url.pathname.endsWith('/gateway/tools')) throw new Error('Invalid gateway endpoint')
  url.pathname = url.pathname.slice(0, -'tools'.length) + operation
  return url.href
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('Run cancelled')); return }
  const stop = () => { clearTimeout(timer); reject(new Error('Run cancelled')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
  signal?.addEventListener('abort', stop, { once: true })
})

/** Fail with a useful transport diagnosis before entering the model loop. This GET cannot invoke a model or a tool. */
export async function probeGateway(input, fetcher = fetch) {
  let probe
  try {
    probe = await fetcher(input.toolEndpoint, { headers: { Authorization: `Bearer ${input.modelGateway.token}` }, signal: AbortSignal.timeout(10000) })
  } catch (error) {
    const code = typeof error.cause?.code === 'string' ? error.cause.code.slice(0, 80) : error.name
    throw new Error(`Gateway connection failed (${code})`, { cause: error })
  }
  if (probe.status !== 405) throw new Error(`Gateway rejected readiness check (${probe.status})`)
}

/**
 * One Server tool call. An outward action (a push, a window, a merge) can wait for a person: the Server
 * answers `outwardPending` and the call is asked again until it is decided, so the model sees one result.
 */
export async function callGatewayTool(input, call, signal, { fetcher = fetch, waitMs = 2000 } = {}) {
  for (;;) {
    const tool = await fetcher(input.toolEndpoint, { method: 'POST', signal,
      headers: { Authorization: `Bearer ${input.modelGateway.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...call, runId: input.runId }) })
    if (!tool.ok) {
      let message = `Tool rejected (${tool.status})`
      if (tool.status === 400) {
        try { const detail = (await tool.json()).error?.message; if (typeof detail === 'string' && detail.startsWith('Invalid tool arguments: ')) message = detail.slice(0, 500) } catch { /* Generic rejection. */ }
      }
      throw new Error(message)
    }
    const result = await tool.json()
    if (result?.outwardPending !== true) return result
    await pause(waitMs, signal)
  }
}
