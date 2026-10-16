import type { InfiniteData } from '@tanstack/vue-query'
import { describe, expect, it } from 'vitest'
import { mergeLatestPage, mergeMessageContext, type MessagePage } from '../../app/utils/message-cache'
import type { MessageContextResponse, MessageDTO } from '../../shared/types'

function message(id: string, createdAt: string, content = id): MessageDTO {
  return {
    id,
    channelId: 'channel-1',
    workspaceId: 'main',
    author: { id: 'user-1', displayName: 'Ada', avatarR2Key: null },
    content,
    replyTo: null,
    mentions: [],
    attachments: [],
    reactions: [],
    pin: null,
    threadId: null,
    editedAt: null,
    deletedAt: null,
    createdAt,
  }
}

function context(messages: MessageDTO[], hasOlder: boolean): MessageContextResponse {
  return {
    messages,
    targetId: messages.at(-1)?.id ?? '',
    targetIndex: Math.max(0, messages.length - 1),
    hasOlder,
    hasNewer: false,
  }
}

describe('mergeMessageContext', () => {
  it('deduplicates and orders the combined context chronologically', () => {
    const current: InfiniteData<MessagePage> = {
      pages: [{
        messages: [
          message('m3', '2026-09-04T00:03:00.000Z'),
          message('m4', '2026-09-04T00:04:00.000Z'),
        ],
        nextCursor: 'm3',
      }],
      pageParams: [undefined],
    }
    const result = mergeMessageContext(current, context([
      message('m1', '2026-09-04T00:01:00.000Z'),
      message('m2', '2026-09-04T00:02:00.000Z'),
      message('m3', '2026-09-04T00:03:00.000Z', 'fresh'),
    ], false))

    expect(result.pages[0]?.messages.map(item => item.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(result.pages[0]?.messages.find(item => item.id === 'm3')?.content).toBe('fresh')
    expect(result.pages[0]?.nextCursor).toBeNull()
  })

  it('uses the context cursor when the context contributes the oldest message', () => {
    const current: InfiniteData<MessagePage> = {
      pages: [{ messages: [message('m4', '2026-09-04T00:04:00.000Z')], nextCursor: 'm4' }],
      pageParams: [undefined],
    }
    const result = mergeMessageContext(current, context([
      message('m2', '2026-09-04T00:02:00.000Z'),
      message('m3', '2026-09-04T00:03:00.000Z'),
    ], true))

    expect(result.pages[0]?.nextCursor).toBe('m2')
  })

  it('uses only the oldest current page to determine remaining history', () => {
    const current: InfiniteData<MessagePage> = {
      pages: [
        { messages: [message('m4', '2026-09-04T00:04:00.000Z')], nextCursor: 'm4' },
        { messages: [message('m1', '2026-09-04T00:01:00.000Z')], nextCursor: null },
      ],
      pageParams: [undefined, 'm4'],
    }
    const result = mergeMessageContext(current, context([
      message('m2', '2026-09-04T00:02:00.000Z'),
      message('m3', '2026-09-04T00:03:00.000Z'),
    ], true))

    expect(result.pages[0]?.nextCursor).toBeNull()
  })
})

describe('reconnect catch-up', () => {
  const at = (minute: number) => `2026-09-28T10:${String(minute).padStart(2, '0')}:00.000Z`
  const cached = (pages: MessageDTO[][], cursor: string | null = null): InfiniteData<MessagePage> => ({
    pages: pages.map((messages, index) => ({ messages, nextCursor: index === pages.length - 1 ? cursor : 'older' })),
    pageParams: pages.map((_, index) => index ? 'older' : undefined),
  })

  it('appends missed messages and refreshes edited ones, keeping older pages', () => {
    const current = cached([[message('m3', at(3)), message('m4', at(4))], [message('m1', at(1))]], 'm1')
    const merged = mergeLatestPage(current, {
      messages: [message('m4', at(4), 'edited'), message('m5', at(5))],
      nextCursor: 'm4',
    })
    expect(merged.pages[0]!.messages.map(item => [item.id, item.content])).toEqual([['m3', 'm3'], ['m4', 'edited'], ['m5', 'm5']])
    expect(merged.pages[1]!.messages.map(item => item.id)).toEqual(['m1'])
  })

  it('keeps unsent optimistic messages last', () => {
    const pending = { ...message('tmp:c1', at(9)), clientId: 'c1', deliveryState: 'sending' as const }
    const merged = mergeLatestPage(cached([[message('m1', at(1)), pending]]), {
      messages: [message('m1', at(1)), message('m2', at(2))],
      nextCursor: null,
    })
    expect(merged.pages[0]!.messages.map(item => item.id)).toEqual(['m1', 'm2', 'tmp:c1'])
  })

  it('replaces the cache when more than a page was missed', () => {
    const merged = mergeLatestPage(cached([[message('m1', at(1))]]), {
      messages: [message('m8', at(8)), message('m9', at(9))],
      nextCursor: 'm8',
    })
    expect(merged.pages).toHaveLength(1)
    expect(merged.pages[0]).toMatchObject({ nextCursor: 'm8' })
    expect(merged.pages[0]!.messages.map(item => item.id)).toEqual(['m8', 'm9'])
  })

  it('returns the cache unchanged in shape when nothing was missed', () => {
    const current = cached([[message('m1', at(1))]])
    expect(mergeLatestPage(current, { messages: [message('m1', at(1))], nextCursor: null }).pages[0]!.messages).toHaveLength(1)
  })
})
