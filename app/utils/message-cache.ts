import type { InfiniteData } from '@tanstack/vue-query'
import type { MessageContextResponse, MessageDTO } from '~~/shared/types'

export type MessagePage = {
  messages: MessageDTO[]
  nextCursor: string | null
}

function compareMessages(left: MessageDTO, right: MessageDTO): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

/** Merge a context window into the infinite-query shape without corrupting its oldest cursor. */
export function mergeMessageContext(
  current: InfiniteData<MessagePage> | undefined,
  context: MessageContextResponse,
): InfiniteData<MessagePage> {
  const currentMessages = (current?.pages ?? []).flatMap(page => page.messages)
  const merged = new Map<string, MessageDTO>()
  for (const message of currentMessages) merged.set(message.id, message)
  for (const message of context.messages) merged.set(message.id, message)

  const messages = [...merged.values()].sort(compareMessages)
  const currentOldest = [...currentMessages].sort(compareMessages)[0]
  const contextOldest = context.messages[0]
  const currentHasOlder = Boolean(current?.pages.at(-1)?.nextCursor)
  let hasOlder: boolean

  if (!currentOldest) hasOlder = context.hasOlder
  else if (!contextOldest) hasOlder = currentHasOlder
  else {
    const oldestComparison = compareMessages(contextOldest, currentOldest)
    if (oldestComparison < 0) hasOlder = context.hasOlder
    else if (oldestComparison > 0) hasOlder = currentHasOlder
    else hasOlder = context.hasOlder || currentHasOlder
  }

  return {
    pages: [{ messages, nextCursor: hasOlder ? messages[0]?.id ?? null : null }],
    pageParams: [undefined],
  }
}

/**
 * Folds a freshly fetched newest page into the cache after the live connection
 * was down: missed messages are appended, edits and deletions replace the cached
 * copies, and older pages and unsent optimistic messages are kept.
 */
export function mergeLatestPage(
  current: InfiniteData<MessagePage> | undefined,
  latest: MessagePage,
): InfiniteData<MessagePage> {
  if (!current?.pages.length) return { pages: [latest], pageParams: [undefined] }
  const fresh = new Map(latest.messages.map(message => [message.id, message]))
  const oldestFresh = latest.messages[0]
  const known = new Set<string>()
  const pages = current.pages.map(page => ({
    ...page,
    messages: page.messages.map((message) => {
      known.add(message.id)
      return fresh.get(message.id) ?? message
    }),
  }))
  const first = pages[0]!
  const missed = latest.messages.filter(message => !known.has(message.id))
  if (!missed.length) return { ...current, pages }
  const pending = first.messages.filter(message => message.id.startsWith('tmp:'))
  const settled = first.messages.filter(message => !message.id.startsWith('tmp:'))
  const newestCached = settled.at(-1)
  // More than a page was missed: the fresh page replaces the cache, since the
  // gap between it and the cached messages cannot be filled.
  if (latest.nextCursor && newestCached && oldestFresh && compareMessages(oldestFresh, newestCached) > 0) {
    return { pages: [{ ...latest, messages: [...latest.messages, ...pending] }], pageParams: [undefined] }
  }
  const merged = [...settled, ...missed].sort(compareMessages)
  pages[0] = { ...first, messages: [...merged, ...pending] }
  return { ...current, pages }
}
