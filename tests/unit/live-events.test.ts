import { describe, expect, it, vi } from 'vitest'
import type { LiveState } from '../../shared/types'
import { signalLiveChanged } from '../../workers/live-events'

class Statement {
  args: unknown[] = []

  constructor(private readonly result: unknown) {}

  bind(...args: unknown[]) {
    this.args = args
    return this
  }

  async first<T>() {
    return this.result as T | null
  }

  async all<T>() {
    return { results: this.result as T[] }
  }
}

function fakeEnv(results: unknown[]) {
  const notifyLiveChanged = vi.fn()
  return {
    notifyLiveChanged,
    env: {
      DB: { prepare: () => new Statement(results.shift()) },
      WORKSPACE_DO: {
        getByName: () => ({ notifyLiveChanged }),
      },
    } as never,
  }
}

const activeCall: LiveState = {
  active: true,
  meetingId: 'meeting',
  participantIds: ['caller'],
  startedBy: 'caller',
  startedAt: '2026-09-08T10:00:00.000Z',
  kind: 'call',
  ringing: true,
}

const caller = { id: 'caller', kind: 'human' as const, displayName: 'Alice', avatarR2Key: null }

describe('workspace Live events', () => {
  it('rings only the other participant when a 1:1 Call starts', async () => {
    const fake = fakeEnv([
      { id: 'dm', name: 'dm', type: 'dm', visibility: 'private' },
      [{ id: 'callee' }, { id: 'caller' }],
    ])

    await signalLiveChanged(fake.env, 'dm', activeCall, { started: caller })

    expect(fake.notifyLiveChanged).toHaveBeenCalledWith(
      expect.objectContaining({ ring: true, notification: expect.objectContaining({ title: 'Alice is calling' }) }),
      ['callee'],
    )
  })

  it('announces a Channel going live once, without ringing', async () => {
    const fake = fakeEnv([
      { id: 'general', name: 'general', type: 'text', visibility: 'workspace' },
      [{ id: 'bob' }, { id: 'caller' }],
    ])

    await signalLiveChanged(fake.env, 'general', { ...activeCall, kind: 'live', ringing: false }, { started: caller })

    expect(fake.notifyLiveChanged).toHaveBeenCalledWith(
      expect.objectContaining({ ring: false, notification: expect.objectContaining({ title: 'Alice is live in #general' }) }),
      ['bob'],
    )
  })

  it('sends joins, leaves, and ends to everyone without an announcement', async () => {
    const fake = fakeEnv([
      { id: 'dm', name: 'dm', type: 'dm', visibility: 'private' },
      [{ id: 'callee' }, { id: 'caller' }],
    ])

    await signalLiveChanged(fake.env, 'dm', { ...activeCall, active: false }, { outcome: 'declined' })

    const [event, recipients] = fake.notifyLiveChanged.mock.calls[0]!
    expect(event).toMatchObject({ ring: false, outcome: 'declined' })
    expect(event).not.toHaveProperty('notification')
    expect(recipients).toEqual(['callee', 'caller'])
  })
})
