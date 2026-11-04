type ShortcutEvent = {
  key?: unknown
  metaKey?: boolean
  ctrlKey?: boolean
}

export function isSearchShortcut(event: ShortcutEvent): boolean {
  return typeof event.key === 'string'
    && event.key.toLowerCase() === 'k'
    && Boolean(event.metaKey || event.ctrlKey)
}
