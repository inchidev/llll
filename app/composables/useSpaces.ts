import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { RemovableRef } from '@vueuse/core'
import type { SpaceDTO } from '~~/shared/spaces'
import { resolveActiveSpace, showSpaceSwitcher } from '../utils/spaces'
import { useSafeLocalStorage } from './useSafeLocalStorage'

let store: RemovableRef<Record<string, string>> | null = null
/**
 * The chosen Space per Server. A tab keeps its Space until it reloads, so another tab switching
 * cannot send this tab's requests to a different Space than the data it has on screen.
 */
export function activeSpaceStore() {
  store ??= useSafeLocalStorage<Record<string, string>>('llll:active-space', {}, { flush: 'sync', listenToStorageChanges: false, writeDefaults: false })
  return store
}

function spaceChoiceStored(spaceId: string) {
  try { return Boolean(localStorage.getItem('llll:active-space')?.includes(spaceId)) }
  catch { return false }
}

export function useSpaces(serverId: MaybeRefOrGetter<string>) {
  const { api } = useApi()
  const qc = useQueryClient()
  const active = activeSpaceStore()
  const spacesQ = useQuery({
    queryKey: computed(() => ['spaces', toValue(serverId)]),
    queryFn: () => api<{ spaces: SpaceDTO[] }>(`/api/servers/${toValue(serverId)}/spaces`),
    enabled: computed(() => Boolean(toValue(serverId))),
  })
  const spaces = computed(() => spacesQ.data.value?.spaces ?? [])
  const canSwitch = computed(() => showSpaceSwitcher(spaces.value))
  const activeSpace = computed(() => resolveActiveSpace(spaces.value, active.value[toValue(serverId)]))
  const isSpaceAdmin = computed(() => spaces.value.some(space => space.role === 'admin'))

  function remember(spaceId: string | undefined) {
    const { [toValue(serverId)]: _previous, ...others } = active.value
    active.value = spaceId ? { ...others, [toValue(serverId)]: spaceId } : others
  }

  // Keep the store on a listed Space: requests read it, and it is empty for anyone with one Space.
  watch(() => spacesQ.data.value?.spaces, list => {
    if (!list) return
    const stored = active.value[toValue(serverId)]
    const wanted = showSpaceSwitcher(list) ? resolveActiveSpace(list, stored)?.id : undefined
    if (wanted === stored) return
    remember(wanted)
    if (!wanted) return
    // What loaded so far was not scoped to this Space, and not all of it lives in the query cache.
    // Reload once the choice is safely stored; with blocked storage a reload would loop.
    if (spaceChoiceStored(wanted)) window.location.reload()
    else void qc.invalidateQueries({ predicate: query => query.queryKey[0] !== 'spaces' })
  }, { immediate: true })

  /** A full reload, so no cached data from the other Space survives. */
  function switchTo(spaceId: string) {
    if (spaceId === activeSpace.value?.id) return
    remember(spaceId)
    window.location.assign('/channels')
  }

  return { spacesQ, spaces, activeSpace, canSwitch, isSpaceAdmin, remember, switchTo }
}
