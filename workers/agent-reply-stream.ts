import { findAgentRun } from '../server/utils/agent-run-service'
import { runStreamAudience } from '../server/utils/agent-tool-security'
import type { AgentRun, RuntimeEvent } from '../shared/agent-execution'
import { asRpc, type L4Env } from './env'

type ChannelStreams = {
  streamAgentReply: (input: { runId: string; agentId: string; initiatedBy: string; audience: 'channel' | 'initiator'; text: string }) => Promise<void>
  endAgentStream: (runId: string) => Promise<void>
}

/** The longest turn a stream shows; the finished message carries the whole answer. */
const STREAM_TEXT_LIMIT = 200_000

export function channelStreams(env: L4Env, channelId: string) {
  return asRpc<ChannelStreams>(env.CHANNEL_DO.getByName(`channel:${channelId}`))
}

/**
 * Sends a Run's answer to its conversation while Pi writes it. It holds the current turn and sends the
 * whole of it at most every `interval`, so the conversation recovers from any single update. A tool
 * call starts a new turn, and the text after it asks again who may watch: the tool may have read a
 * private source.
 */
export function agentReplyStream(env: L4Env, runId: string, options: { interval?: number } = {}) {
  let run: AgentRun | null | undefined
  let audience: 'channel' | 'initiator' | undefined
  let text = ''
  let sent: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let sending: Promise<void> = Promise.resolve()
  let closed = false
  // The text after a tool call is written once the tool has run, so that is when to ask again.
  let afterTool = false

  const flush = () => {
    timer = undefined
    sending = sending.then(async () => {
      if (closed) return
      run ??= await findAgentRun(env, runId)
      if (!run || run.status !== 'running') return
      audience ??= await runStreamAudience(env, run)
      const snapshot = text
      if (snapshot === sent) return
      await channelStreams(env, run.channelId).streamAgentReply({ runId, agentId: run.agentId, initiatedBy: run.initiatedBy, audience, text: snapshot })
      sent = snapshot
    }).catch(() => undefined)
  }
  // Long answers are sent less often: each update carries the whole turn.
  const arm = () => {
    if (closed || timer) return
    timer = setTimeout(flush, Math.max(options.interval ?? 150, Math.min(1000, Math.floor(text.length / 40))))
  }

  return {
    event(event: RuntimeEvent) {
      if (closed) return
      if (event.type === 'text') {
        if (afterTool) { audience = undefined; afterTool = false }
        if (text.length >= STREAM_TEXT_LIMIT) return
        text = (text + event.text).slice(0, STREAM_TEXT_LIMIT)
        arm()
      } else if (event.type === 'tool') {
        text = ''
        afterTool = true
        arm()
      }
    },
    /** Stops sending and waits for an update in flight, so none arrives after the finished message. */
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      await sending
    },
  }
}
