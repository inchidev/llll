import type { InfiniteData } from '@tanstack/vue-query'
import type { MailboxDTO, MailMessageDTO, MailThreadDTO, MailThreadPageDTO } from '~~/shared/types'

export type MailThreadPages = InfiniteData<MailThreadPageDTO, string>
export type MailThreadDetail = { thread: MailThreadDTO; messages: MailMessageDTO[] }

function mapThreads(data: MailThreadPages | undefined, update: (threads: MailThreadDTO[], pageIndex: number) => MailThreadDTO[]) {
  if (!data) return data
  return { ...data, pages: data.pages.map((page, index) => ({ ...page, threads: update(page.threads, index) })) }
}

/** The conversation leaves this folder's list, as when it is archived. */
export function withoutThread(data: MailThreadPages | undefined, threadId: string) {
  return mapThreads(data, threads => threads.filter(thread => thread.channelId !== threadId))
}

export function withThreadRead(data: MailThreadPages | undefined, threadId: string) {
  return mapThreads(data, threads => threads.map(thread => thread.channelId === threadId ? { ...thread, unread: false } : thread))
}

/** Puts a conversation first, replacing its older entry wherever it was. */
export function withThreadFirst(data: MailThreadPages | undefined, thread: MailThreadDTO) {
  return mapThreads(data, (threads, index) => {
    const rest = threads.filter(existing => existing.channelId !== thread.channelId)
    return index === 0 ? [thread, ...rest] : rest
  })
}

/** A new message in a conversation moves it to the top with that message as its preview. */
export function withThreadActivity(data: MailThreadPages | undefined, threadId: string, message: MailMessageDTO) {
  const current = data?.pages.flatMap(page => page.threads).find(thread => thread.channelId === threadId)
  if (!current) return data
  return withThreadFirst(data, { ...current, preview: message.content.slice(0, 240), lastMessageAt: message.createdAt })
}

/** Adds a message to an open conversation, or replaces the one with `replaceId`. */
export function withMessage(detail: MailThreadDetail | undefined, message: MailMessageDTO, replaceId: string = message.id) {
  if (!detail) return detail
  const replaced = detail.messages.some(existing => existing.id === replaceId)
  const messages = replaced
    ? detail.messages.map(existing => existing.id === replaceId ? message : existing)
    : [...detail.messages.filter(existing => existing.id !== message.id), message]
  return { ...detail, messages }
}

export function withoutMessage(detail: MailThreadDetail | undefined, messageId: string) {
  if (!detail) return detail
  return { ...detail, messages: detail.messages.filter(message => message.id !== messageId) }
}

export function withMailboxUnread(data: { mailboxes: MailboxDTO[] } | undefined, mailboxId: string, change: number) {
  if (!data) return data
  return {
    mailboxes: data.mailboxes.map(mailbox => mailbox.channelId === mailboxId
      ? { ...mailbox, unreadCount: Math.max(0, mailbox.unreadCount + change) }
      : mailbox),
  }
}
