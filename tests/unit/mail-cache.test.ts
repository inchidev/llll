import { QueryClient } from '@tanstack/vue-query'
import { describe, expect, it } from 'vitest'
import { withMailboxUnread, withMessage, withoutThread, withThreadActivity, withThreadRead, type MailThreadPages } from '../../app/utils/mail-cache'
import { applyWorkspaceRealtimeEvent } from '../../app/utils/workspace-realtime'
import type { MailMessageDTO, MailThreadDTO } from '../../shared/types'

function thread(id: string, lastMessageAt: string, unread = false): MailThreadDTO {
  return { channelId: id, mailboxChannelId: 'support', subject: id, status: 'inbox', participants: [], preview: '', lastMessageAt, unread }
}
function pages(...lists: MailThreadDTO[][]): MailThreadPages {
  return { pages: lists.map(threads => ({ threads, nextCursor: null })), pageParams: lists.map(() => '') }
}
function message(id: string, content = id): MailMessageDTO {
  return { id, content, createdAt: '2026-09-29T12:00:00.000Z' } as MailMessageDTO
}

describe('mail cache', () => {
  it('moves a conversation with new activity to the top of the first page', () => {
    const data = pages([thread('a', '3'), thread('b', '2')], [thread('c', '1')])
    const updated = withThreadActivity(data, 'c', message('m', 'New reply'))!
    expect(updated.pages.map(page => page.threads.map(item => item.channelId))).toEqual([['c', 'a', 'b'], []])
    expect(updated.pages[0]!.threads[0]).toMatchObject({ preview: 'New reply', lastMessageAt: '2026-09-29T12:00:00.000Z' })
  })

  it('removes a moved conversation and clears an opened one’s unread mark', () => {
    const data = pages([thread('a', '2', true), thread('b', '1', true)])
    expect(withoutThread(data, 'a')!.pages[0]!.threads.map(item => item.channelId)).toEqual(['b'])
    expect(withThreadRead(data, 'b')!.pages[0]!.threads.map(item => item.unread)).toEqual([true, false])
    expect(withMailboxUnread({ mailboxes: [{ channelId: 'support', unreadCount: 0 } as never] }, 'support', -1)!.mailboxes[0]!.unreadCount).toBe(0)
  })

  it('replaces a pending reply with the saved email', () => {
    const detail = { thread: thread('a', '1'), messages: [message('first'), message('tmp:key', 'Thanks')] }
    const saved = withMessage(detail, message('saved', 'Thanks'), 'tmp:key')!
    expect(saved.messages.map(item => item.id)).toEqual(['first', 'saved'])
    expect(withMessage(saved, message('saved', 'Thanks'))!.messages).toHaveLength(2)
  })

  it('refreshes the affected mailbox when mail changes elsewhere', () => {
    const cache = new QueryClient()
    for (const key of [['mailboxes'], ['mail-threads', 'support', 'inbox'], ['mail-threads', 'sales', 'inbox'], ['mail-thread', 'a']]) cache.setQueryData(key, {})
    applyWorkspaceRealtimeEvent(cache, { t: 'mail.changed', mailboxId: 'support', threadId: 'a' })
    const stale = (key: unknown[]) => cache.getQueryState(key)?.isInvalidated
    expect([stale(['mailboxes']), stale(['mail-threads', 'support', 'inbox']), stale(['mail-thread', 'a']), stale(['mail-threads', 'sales', 'inbox'])])
      .toEqual([true, true, true, false])
  })
})
