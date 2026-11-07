import { DatabaseSync } from 'node:sqlite'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'

const author = { id: 'agent-1', kind: 'agent' as const, displayName: 'Pi', avatarR2Key: null }
const stream = { runId: '01990000-0000-4000-8000-000000000001', author, startedAt: '2026-11-07T10:00:00.000Z' }

describe('an answer in the conversation while it is written', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('appends deltas in order, replaces the text when a turn starts, and ends', async () => {
    const { usePresenceStore } = await import('../../app/stores/presence')
    const presence = usePresenceStore()
    presence.applyAgentStream('thread-1', stream, 0, '')
    presence.applyAgentStream('thread-1', stream, 0, 'Hel')
    presence.applyAgentStream('thread-1', stream, 3, 'lo')
    expect(presence.agentStreamsIn('thread-1')).toEqual([{ ...stream, text: 'Hello' }])
    // A delta after one this socket missed is not applied out of place; the next snapshot restores it.
    presence.applyAgentStream('thread-1', stream, 9, ' world')
    expect(presence.agentStreamsIn('thread-1')[0]!.text).toBe('Hello')
    presence.applyAgentStream('thread-1', stream, 0, 'After the tool')
    expect(presence.agentStreamsIn('thread-1')[0]!.text).toBe('After the tool')
    presence.hydrateAgentStreams('thread-1', [{ ...stream, text: 'Snapshot' }])
    expect(presence.agentStreamsIn('thread-1')[0]!.text).toBe('Snapshot')
    presence.endAgentStream('thread-1', stream.runId)
    expect(presence.agentStreamsIn('thread-1')).toEqual([])
    expect(presence.agentStreamsIn('another')).toEqual([])
  })
})

describe('the Run side of a stream', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); for (const path of ['../../server/utils/agent-run-service', '../../server/utils/agent-tool-security', 'cloudflare:workers', '../../workers/agent-pi-durable']) vi.doUnmock(path) })

  async function fixture(audiences: Array<'channel' | 'initiator'>) {
    const run = { id: stream.runId, channelId: 'thread-1', agentId: 'agent-1', initiatedBy: 'member-1', status: 'running' } as AgentRun
    const audience = vi.fn(async () => audiences.shift() ?? 'initiator')
    vi.doMock('../../server/utils/agent-run-service', () => ({ findAgentRun: async () => run }))
    vi.doMock('../../server/utils/agent-tool-security', () => ({ runStreamAudience: audience }))
    const sent: Array<{ audience: string; text: string }> = []
    const ended: string[] = []
    const env = { CHANNEL_DO: { getByName: (name: string) => {
      expect(name).toBe('channel:thread-1')
      return { streamAgentReply: async (input: { audience: string; text: string }) => { sent.push({ audience: input.audience, text: input.text }) }, endAgentStream: async (id: string) => { ended.push(id) } }
    } } } as unknown as L4Env
    const { agentReplyStream } = await import('../../workers/agent-reply-stream')
    return { stream: agentReplyStream(env, stream.runId), sent, ended, audience, env }
  }

  it('sends the whole current turn at most every interval, and asks again after a tool has run', async () => {
    vi.useFakeTimers()
    const f = await fixture(['channel', 'initiator'])
    f.stream.event({ type: 'text', text: 'Let me ' })
    f.stream.event({ type: 'text', text: 'check.' })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.sent).toEqual([{ audience: 'channel', text: 'Let me check.' }])
    // The tool call starts a new turn; the text written after the tool asks who may watch it.
    f.stream.event({ type: 'tool', name: 'search_data' })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.sent.at(-1)).toEqual({ audience: 'channel', text: '' })
    f.stream.event({ type: 'text', text: 'Found it.' })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.sent.at(-1)).toEqual({ audience: 'initiator', text: 'Found it.' })
    expect(f.audience).toHaveBeenCalledTimes(2)
  })

  it('streams a box’s deltas as they reach the Run, and a resent batch never repeats text', async () => {
    vi.useFakeTimers()
    const f = await fixture(['channel'])
    vi.doMock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
    vi.doMock('../../workers/agent-pi-durable', () => ({ runEmbeddedPi: vi.fn() }))
    const { AgentRunDurableObject } = await import('../../workers/agent-run-do')
    const db = new DatabaseSync(':memory:'), values = new Map<string, unknown>([['runId', stream.runId], ['box', true]])
    const storage = {
      sql: { exec(query: string, ...args: Array<string | number>) {
        const statement = db.prepare(query)
        if (statement.columns().length) return { toArray: () => statement.all(...args) }
        statement.run(...args)
      } },
      transactionSync<T>(callback: () => T) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } },
      get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value) }, delete: async (key: string) => values.delete(key), setAlarm: async () => {},
    }
    const run = new AgentRunDurableObject({ storage, waitUntil: () => {} } as unknown as DurableObjectState, f.env)
    try {
      expect(await run.boxEvents(stream.runId, 0, [{ type: 'text', text: 'Let me ' }, { type: 'text', text: 'check.' }])).toMatchObject({ ack: 2 })
      await vi.advanceTimersByTimeAsync(200)
      expect(f.sent).toEqual([{ audience: 'channel', text: 'Let me check.' }])
      // The box did not hear the answer and sends the batch again, with what it wrote since.
      expect(await run.boxEvents(stream.runId, 0, [{ type: 'text', text: 'Let me ' }, { type: 'text', text: 'check.' }, { type: 'text', text: ' Done.' }])).toMatchObject({ ack: 3 })
      await vi.advanceTimersByTimeAsync(200)
      expect(f.sent.at(-1)).toEqual({ audience: 'channel', text: 'Let me check. Done.' })
      // A tool step starts a new turn of the stream and asks again who may watch, as for embedded Pi.
      await run.boxEvents(stream.runId, 3, [{ type: 'tool', name: 'bash' }, { type: 'text', text: 'Tests pass.' }])
      await vi.advanceTimersByTimeAsync(200)
      expect(f.sent.at(-1)).toEqual({ audience: 'initiator', text: 'Tests pass.' })
      expect(f.audience).toHaveBeenCalledTimes(2)
    } finally { db.close() }
  })

  it('sends nothing after it is closed, so no update follows the finished message', async () => {
    vi.useFakeTimers()
    const f = await fixture(['channel'])
    f.stream.event({ type: 'text', text: 'Almost' })
    await f.stream.close()
    f.stream.event({ type: 'text', text: ' done' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.sent).toEqual([])
  })
})
