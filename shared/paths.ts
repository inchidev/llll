export type ChannelRef = {
  id: string
  name?: string | null
  type?: string | null
}

export function channelPath(channel: string | ChannelRef, threadId?: string): string {
  const id = typeof channel === 'string' ? channel : channel.id
  if (threadId) return `/channels/${id}/threads/${threadId}`
  return `/channels/${id}`
}

/** A thread status, or Sent: every conversation you have sent email in. */
export type MailFolder = 'inbox' | 'sent' | 'archive' | 'spam' | 'trash'

export const MAIL_FOLDERS: MailFolder[] = ['inbox', 'sent', 'archive', 'spam', 'trash']

export function isMailFolder(value: unknown): value is MailFolder {
  return typeof value === 'string' && (MAIL_FOLDERS as string[]).includes(value)
}

export function mailPath(mailboxId: string, folder: MailFolder = 'inbox', threadId?: string): string {
  const path = `/mail/${mailboxId}/${folder}`
  return threadId ? `${path}?thread=${threadId}` : path
}

export function boardPath(boardId?: string | null, archived = false): string {
  const query = new URLSearchParams()
  if (boardId) query.set('board', boardId)
  if (archived) query.set('archived', '1')
  const suffix = query.toString()
  return suffix ? `/tasks?${suffix}` : '/tasks'
}

export function databasePath(databaseId?: string | null, archived = false, viewId?: string | null): string {
  const query = new URLSearchParams()
  if (databaseId) query.set('database', databaseId)
  if (viewId) query.set('view', viewId)
  if (archived) query.set('archived', '1')
  const suffix = query.toString()
  return suffix ? `/databases?${suffix}` : '/databases'
}

export function documentPath(documentId?: string | null): string {
  return documentId ? `/documents?document=${encodeURIComponent(documentId)}` : '/documents'
}

export function canvasPath(canvasId?: string | null): string {
  return canvasId ? `/canvases?canvas=${encodeURIComponent(canvasId)}` : '/canvases'
}

export function gadgetPath(gadgetId?: string | null, edit = false): string {
  const query = new URLSearchParams()
  if (gadgetId) query.set('gadget', gadgetId)
  if (edit) query.set('edit', '1')
  const suffix = query.toString()
  return suffix ? `/gadgets?${suffix}` : '/gadgets'
}
