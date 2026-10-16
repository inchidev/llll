import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unreadChannelCount } from '../../app/utils/attention'
import { applyReactionChange } from '../../app/utils/message-reactions'
import { createTypingActivity, TYPING_IDLE_MS, TYPING_REFRESH_MS } from '../../app/utils/typing-activity'
import type { ChannelDTO } from '../../shared/types'
import { PRESENCE_IDLE_MS, workspacePresence } from '../../workers/workspace-presence'

describe('typing activity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('appears on the first keystroke, refreshes during continuous input, and stops after idle', () => {
    const emit = vi.fn()
    const typing = createTypingActivity(emit)

    typing.input()
    expect(emit).toHaveBeenLastCalledWith(true)

    vi.advanceTimersByTime(TYPING_REFRESH_MS - 1)
    typing.input()
    expect(emit).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    typing.input()
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith(true)

    vi.advanceTimersByTime(TYPING_IDLE_MS)
    expect(emit).toHaveBeenLastCalledWith(false)
  })

  it('emits stop immediately when the composer is cleared', () => {
    const emit = vi.fn()
    const typing = createTypingActivity(emit)
    typing.input()
    typing.stop()
    expect(emit.mock.calls).toEqual([[true], [false]])
  })
})

describe('optimistic reactions', () => {
  it('does not double-count the sender echo after an optimistic add', () => {
    const optimistic = applyReactionChange([], { emoji: '👍', userId: 'me', op: 'add' }, 'me')
    expect(applyReactionChange(optimistic, { emoji: '👍', userId: 'me', op: 'add' }, 'me'))
      .toEqual([{ emoji: '👍', count: 1, me: true }])
  })

  it('does not double-decrement the sender echo after an optimistic remove', () => {
    const optimistic = applyReactionChange([{ emoji: '👍', count: 2, me: true }], { emoji: '👍', userId: 'me', op: 'remove' }, 'me')
    expect(applyReactionChange(optimistic, { emoji: '👍', userId: 'me', op: 'remove' }, 'me'))
      .toEqual([{ emoji: '👍', count: 1, me: false }])
  })
})

describe('unread attention', () => {
  it('counts unread conversations once across overlapping caches', () => {
    const channel = (id: string, unread: boolean) => ({ id, unread }) as ChannelDTO
    expect(unreadChannelCount([
      { channels: [channel('general', true), channel('random', false)] },
      { channels: [channel('general', true), channel('dm', true)] },
    ])).toBe(2)
  })
})

describe('workspace presence', () => {
  it('hides invisible sockets and uses the freshest visible tab', () => {
    const socket = (userId: string, lastActive: number, visible: boolean) => ({
      deserializeAttachment: () => ({ userId, lastActive, visible }),
    })
    const now = 10_000_000
    expect(workspacePresence([
      socket('hidden', now, false),
      socket('member', now - PRESENCE_IDLE_MS - 1, true),
      socket('member', now - 1000, true),
      socket('idle', now - PRESENCE_IDLE_MS - 1, true),
    ], now)).toEqual([
      { userId: 'member', status: 'online' },
      { userId: 'idle', status: 'idle' },
    ])
  })
})
