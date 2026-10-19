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
  | ServerChannelActivityEvent
  | ServerChannelReadEvent
  | ServerTasksChangedEvent
  | ServerMailChangedEvent
  | ServerMembersChangedEvent
  | ServerLiveChangedEvent
