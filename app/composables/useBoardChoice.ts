import type { RemovableRef } from '@vueuse/core'
import { activeSpaceStore } from './useSpaces'
import { useSafeLocalStorage } from './useSafeLocalStorage'

let store: RemovableRef<Record<string, string>> | null = null

/** The board last chosen in this Space on this device, and the one on screen now. */
export function useBoardChoice(serverId: MaybeRefOrGetter<string>) {
  store ??= useSafeLocalStorage<Record<string, string>>('llll:last-board', {}, { writeDefaults: false })
  const saved = store
  const activeBoardId = useState<string | null>('board:active', () => null)
  const key = computed(() => `${toValue(serverId)}:${activeSpaceStore().value[toValue(serverId)] ?? ''}`)
  const lastBoardId = computed(() => saved.value[key.value] ?? null)
  function remember(boardId: string) {
    if (saved.value[key.value] !== boardId) saved.value = { ...saved.value, [key.value]: boardId }
  }
  return { activeBoardId, lastBoardId, remember }
}
