import type { LiveState } from './types'

export type ServerChannelActivityEvent = {
  t: 'channel.activity'
  sourceChannelId: string
  rootChannelId: string
  messageId: string
  notification: {
    title: string
    body: string
    url: string
  }
}

export type ServerChannelReadEvent = {
  t: 'channel.read'
  sourceChannelId: string
  rootChannelId: string
  messageId: string
  unread: boolean
}

export type ServerTasksChangedEvent = {
  t: 'tasks.changed'
  boardId: string | null
  taskId: string | null
}

/** Something changed in a mailbox: new mail, a reply or note, a delivery result, or a move. */
export type ServerMailChangedEvent = {
  t: 'mail.changed'
  mailboxId: string
  threadId: string | null
}

export type ServerMembersChangedEvent = {
  t: 'members.changed'
  serverId: string
}

export type ServerChannelAccessChangedEvent = {
  t: 'channel.access.changed'
  serverId: string
  channelId: string
  conversationIds: string[]
  revoked: boolean
}

/**
 * The Server's channel layout changed: a channel or category was created, renamed, moved,
 * archived, restored or deleted, or a Thread was deleted. Clients refetch their channel list;
 * deleted conversations leave their caches at once.
 */
export type ServerChannelsChangedEvent = {
  t: 'channels.changed'
  serverId: string
  /** Deleted conversations: a channel with its Threads, or one Thread. */
  deletedIds: string[]
  /** Conversations whose Thread list changed. */
  parentIds: string[]
  /** Conversations that remain but whose own state changed, such as an archived channel with its Threads. */
  updatedIds?: string[]
}

export type ServerLiveChangedEvent = {
  t: 'live.changed'
  channelId: string
  live: LiveState
  /** Ring this recipient: a new 1:1 Call. */
  ring: boolean
  /** Why a Call ended before it was answered, for the caller. */
  outcome?: 'declined' | 'unanswered'
  /** Only when the room just started: announce it or ring for it. */
  notification?: {
    title: string
    body: string
    url: string
  }
}

export type ServerRealtimeEvent =
  | ServerChannelAccessChangedEvent
  | ServerChannelsChangedEvent
  | ServerChannelActivityEvent
  | ServerChannelReadEvent
  | ServerTasksChangedEvent
  | ServerMailChangedEvent
  | ServerMembersChangedEvent
  | ServerLiveChangedEvent
