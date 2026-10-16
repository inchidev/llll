import { useLocalStorage, type RemovableRef, type UseStorageOptions } from '@vueuse/core'
import { ref, toValue, type MaybeRefOrGetter } from 'vue'

/** Embedded browsers may throw while accessing the storage getter itself. */
export function useSafeLocalStorage<T>(key: MaybeRefOrGetter<string>, initial: MaybeRefOrGetter<T>, options?: UseStorageOptions<T>): RemovableRef<T> {
  try { return useLocalStorage<T>(key, initial, options) }
  catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return ref(toValue(initial)) as RemovableRef<T>
  }
}
