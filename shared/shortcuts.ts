type ShortcutEvent = {
  key?: unknown
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
}

export function isSearchShortcut(event: ShortcutEvent): boolean {
  return typeof event.key === 'string'
    && event.key.toLowerCase() === 'k'
    && Boolean(event.metaKey || event.ctrlKey)
    && !event.shiftKey && !event.altKey && !event.isComposing
}

export function isConversationSearchShortcut(event: ShortcutEvent): boolean {
  return typeof event.key === 'string' && event.key.toLowerCase() === 'f'
    && Boolean(event.metaKey || event.ctrlKey) && Boolean(event.shiftKey) && !event.altKey && !event.isComposing
}
