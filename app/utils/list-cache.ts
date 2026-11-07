import type { QueryClient, QueryKey } from '@tanstack/vue-query'

/**
 * Puts what a create or update returned into the list it belongs to, so the list shows it as its dialog closes.
 * The refetch that follows only confirms it; on a Server far away that round trip takes a second or more, and a
 * list that waited for it showed "No … yet" after the dialog had closed.
 */
export function putInList<T extends { id: string }, K extends string>(cache: QueryClient, key: QueryKey, field: K, item: T) {
  cache.setQueryData<Record<K, T[]>>(key, old => {
    if (!old) return old
    const items = old[field] ?? []
    return { ...old, [field]: items.some(entry => entry.id === item.id) ? items.map(entry => entry.id === item.id ? item : entry) : [...items, item] }
  })
}
/** Takes a deleted item out of its list at once, before the refetch that confirms it. */
export function dropFromList<K extends string>(cache: QueryClient, key: QueryKey, field: K, id: string) {
  cache.setQueryData<Record<K, Array<{ id: string }>>>(key, old => old && { ...old, [field]: (old[field] ?? []).filter(entry => entry.id !== id) })
}
