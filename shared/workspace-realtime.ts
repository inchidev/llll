import type { LiveState } from './types'

export type WorkspaceChannelActivityEvent = {
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

export type WorkspaceChannelReadEvent = {
  t: 'channel.read'
  sourceChannelId: string
  rootChannelId: string
  messageId: string
  unread: boolean
}

export type WorkspaceTasksChangedEvent = {
  t: 'tasks.changed'
  boardId: string | null
  taskId: string | null
}

/** Something changed in a mailbox: new mail, a reply or note, a delivery result, or a move. */
export type WorkspaceMailChangedEvent = {
  t: 'mail.changed'
  mailboxId: string
  threadId: string | null
}

export type WorkspaceMembersChangedEvent = {
  t: 'members.changed'
  workspaceId: string
}

export type WorkspaceLiveChangedEvent = {
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

export type WorkspaceRealtimeEvent =
  | WorkspaceChannelActivityEvent
  | WorkspaceChannelReadEvent
  | WorkspaceTasksChangedEvent
  | WorkspaceMailChangedEvent
  | WorkspaceMembersChangedEvent
  | WorkspaceLiveChangedEvent
