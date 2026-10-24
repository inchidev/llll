import type { QueryClient } from '@tanstack/vue-query'
import type { ChannelDTO, SidebarThreadDTO } from '~~/shared/types'
import type { ServerRealtimeEvent } from '~~/shared/server-realtime'

type ChannelList = { channels: ChannelDTO[], threads?: SidebarThreadDTO[] }
type ServerQueryCache = Pick<QueryClient, 'getQueryData' | 'setQueryData' | 'setQueriesData' | 'invalidateQueries' | 'removeQueries'>

function applyUnread(cache: ServerQueryCache, channelId: string, unread: boolean, increment = false) {
  let found = false
  const update = (old: ChannelList | undefined) => {
    if (!old?.channels.some(channel => channel.id === channelId)) return old
    found = true
    return {
      ...old,
      channels: old.channels.map(channel => channel.id === channelId
        ? {
            ...channel,
            unread,
            unreadCount: unread ? (increment ? (channel.unreadCount ?? 0) + 1 : channel.unreadCount) : 0,
          }
        : channel),
    }
  }
  cache.setQueriesData<ChannelList>({ queryKey: ['channels'] }, update)
  cache.setQueriesData<ChannelList>({ queryKey: ['dms'] }, update)
  if (!found) {
    void cache.invalidateQueries({ queryKey: ['channels'] })
    void cache.invalidateQueries({ queryKey: ['dms'] })
  }
}

/**
 * Keeps a thread listed under its channel in step with activity: new replies
 * bump it (and count as unread once the member has opened it), reads clear it.
 * A thread not listed yet (newly active) refreshes the channel list.
 */
function applyThreadActivity(cache: ServerQueryCache, threadId: string, parentId: string, change: { unread: boolean | 'if-opened', increment?: boolean, at?: string }) {
  let found = false
  let parentListed = false
  const update = (old: ChannelList | undefined) => {
    if (old?.channels.some(channel => channel.id === parentId)) parentListed = true
    if (!old?.threads?.some(thread => thread.id === threadId)) return old
    found = true
    return {
      ...old,
      threads: old.threads.map((thread) => {
        if (thread.id !== threadId) return thread
        const unread = change.unread === 'if-opened' ? thread.opened : change.unread
        return {
          ...thread,
          opened: thread.opened || change.unread === false,
          unread,
          unreadCount: unread ? thread.unreadCount + (change.increment ? 1 : 0) : 0,
          lastMessageAt: change.at ?? thread.lastMessageAt,
        }
      }),
    }
  }
  cache.setQueriesData<ChannelList>({ queryKey: ['channels'] }, update)
  cache.setQueriesData<ChannelList>({ queryKey: ['dms'] }, update)
  if (!found && parentListed && change.increment) {
    void cache.invalidateQueries({ queryKey: ['channels'] })
    void cache.invalidateQueries({ queryKey: ['dms'] })
  }
}

export function applyServerRealtimeEvent(cache: ServerQueryCache, event: ServerRealtimeEvent) {
  if (event.t === 'channel.access.changed') {
    if (event.revoked) {
      const ids = new Set(event.conversationIds)
      cache.setQueryData<ChannelList>(['channels', event.serverId], old => old ? {
        ...old,
        channels: old.channels.filter(channel => !ids.has(channel.id)),
        threads: old.threads?.filter(thread => !ids.has(thread.id)),
      } : old)
      for (const id of ids) for (const kind of ['channel', 'messages', 'threads', 'files', 'pins', 'message-search', 'readCursor', 'private-channel-members']) {
        cache.removeQueries({ queryKey: [kind, id] })
      }
    }
    void cache.invalidateQueries({ queryKey: ['channels', event.serverId] })
    void cache.invalidateQueries({ queryKey: ['private-channel-members', event.channelId] })
    return
  }
  if (event.t === 'members.changed') {
    void cache.invalidateQueries({ queryKey: ['members', event.serverId] })
    void cache.invalidateQueries({ queryKey: ['roles', event.serverId] })
    void cache.invalidateQueries({ queryKey: ['dms'] })
    return
  }
  if (event.t === 'mail.changed') {
    void cache.invalidateQueries({ queryKey: ['mailboxes'] })
    void cache.invalidateQueries({ queryKey: ['mail-threads', event.mailboxId] })
    if (event.threadId) void cache.invalidateQueries({ queryKey: ['mail-thread', event.threadId] })
    return
  }
  if (event.t === 'tasks.changed') {
    void cache.invalidateQueries({ queryKey: ['boards'] })
    if (event.taskId) void cache.invalidateQueries({ queryKey: ['task', event.taskId] })
    return
  }
  if (event.t === 'live.changed') {
    const update = (old: ChannelList | undefined) => old
      ? {
          ...old,
          channels: old.channels.map(channel => channel.id === event.channelId
            ? {
                ...channel,
                live: event.live.active ? event.live : null,
                liveMeetingId: event.live.meetingId,
              }
            : channel),
        }
      : old
    cache.setQueriesData<ChannelList>({ queryKey: ['channels'] }, update)
    cache.setQueriesData<ChannelList>({ queryKey: ['dms'] }, update)
    return
  }
  const readCursor = cache.getQueryData<string>(['readCursor', event.sourceChannelId])
  const inThread = event.sourceChannelId !== event.rootChannelId
  if (event.t === 'channel.activity') {
    if (!readCursor || readCursor < event.messageId) {
      applyUnread(cache, event.rootChannelId, true, true)
      // Only threads the member has opened count as unread; the channel already shows the activity.
      if (inThread) applyThreadActivity(cache, event.sourceChannelId, event.rootChannelId, { unread: 'if-opened', increment: true, at: new Date().toISOString() })
    }
    return
  }
  if (!readCursor || readCursor < event.messageId) {
    cache.setQueryData(['readCursor', event.sourceChannelId], event.messageId)
  }
  applyUnread(cache, event.rootChannelId, event.unread)
  if (inThread) applyThreadActivity(cache, event.sourceChannelId, event.rootChannelId, { unread: false })
}
