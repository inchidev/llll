/** What one runtime event may hold, as the Server parses it. */
const TEXT_CHARS = 32000, PER_REQUEST = 100

/**
 * Pushes a box's turn to the Server: `POST …/gateway/events {from, events, result?}`. The Server never
 * calls a box, so this is also how the box hears back: each answer carries `ack` (events the Run holds),
 * `cancel` and the steering sent so far.
 *
 * Events go out in order, one request at a time, about every `batchMs` while text flows; consecutive text
 * deltas not yet sent travel as one event. A request that fails is sent again from the same `from`, and
 * the Run keeps only what follows what it has, so a lost answer never doubles text. With nothing to send,
 * a heartbeat every `heartbeatMs` keeps cancellation and steering arriving during a long command.
 */
export function createPushBatcher({ url, token, fetcher = fetch, onCancel, onSteer, steered = [], batchMs = 150, heartbeatMs = 10000, retryMs = 1000, giveUpMs = 300000 }) {
  const queue = [], seen = new Set(steered)
  let acked = 0, inflight = 0, sending = null, timer = null, final = null, cancelled = false, closed = false
  let delivered, settle
  const finished = new Promise(resolve => { settle = value => { if (delivered === undefined) { delivered = value; resolve(value) } } })

  const schedule = ms => {
    if (closed || timer || sending) return
    timer = setTimeout(() => { timer = null; void send() }, ms)
  }
  const heartbeat = setInterval(() => { if (!queue.length && !final) void send() }, heartbeatMs)
  heartbeat.unref?.()

  async function send() {
    if (closed || sending) return
    const batch = queue.slice(0, PER_REQUEST), from = acked, withResult = Boolean(final) && queue.length <= PER_REQUEST
    inflight = batch.length
    let retry = false
    sending = (async () => {
      try {
        const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, events: batch, ...(withResult ? { result: final } : {}) }) })
        if (!response.ok) {
          // The Run's capability was refused or the request is malformed: sending again cannot help.
          if (response.status >= 400 && response.status < 500 && response.status !== 429) { stop(false); return }
          throw new Error(`Events rejected (${response.status})`)
        }
        const answer = await response.json()
        const ack = Number.isSafeInteger(answer?.ack) && answer.ack >= 0 ? answer.ack : from
        // The Run holds `ack` events: drop what it has and send the rest from there.
        queue.splice(0, Math.min(Math.max(0, ack - from), queue.length))
        acked = ack
        if (answer.cancel === true && !cancelled) { cancelled = true; onCancel?.() }
        for (const message of Array.isArray(answer.steer) ? answer.steer : []) {
          if (typeof message?.messageId !== 'string' || typeof message.content !== 'string' || seen.has(message.messageId)) continue
          seen.add(message.messageId)
          onSteer?.(message)
        }
        if (withResult && ack >= from + batch.length) stop(true)
      } catch { retry = true }
    })()
    await sending
    sending = null
    inflight = 0
    if (closed) return
    if (retry) schedule(retryMs)
    else if (queue.length || final) schedule(0)
  }

  function stop(value) {
    closed = true
    clearInterval(heartbeat)
    if (timer) { clearTimeout(timer); timer = null }
    settle(value)
  }

  return {
    /** Queue one event of the turn. */
    push(event) {
      if (closed || final) return
      if (event.type !== 'text') queue.push(event)
      else for (let at = 0; at < event.text.length; at += TEXT_CHARS) {
        const text = event.text.slice(at, at + TEXT_CHARS), last = queue.at(-1)
        // Text not yet on its way joins the delta before it; text already sent stays as it was sent.
        if (last?.type === 'text' && queue.length > inflight && last.text.length + text.length <= TEXT_CHARS) last.text += text
        else queue.push({ type: 'text', text })
      }
      schedule(batchMs)
    },
    /** End the turn with its result; resolves true once the Run has every event and the result. */
    finish(result) {
      if (!closed && !final) {
        final = result
        if (timer) { clearTimeout(timer); timer = null }
        void send()
        setTimeout(() => stop(false), giveUpMs).unref?.()
      }
      return finished
    },
    close() { stop(false) },
    get acknowledged() { return acked },
    get cancelled() { return cancelled },
  }
}
