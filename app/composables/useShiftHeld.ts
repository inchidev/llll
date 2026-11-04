import { createSharedComposable, useEventListener } from '@vueuse/core'

/**
 * Whether Shift is held, shared by every message row: holding it swaps the
 * toolbar to quick pin and delete-without-confirmation, like Discord.
 */
export const useShiftHeld = createSharedComposable(() => {
  const held = ref(false)
  if (import.meta.client) {
    useEventListener(window, 'keydown', (event: KeyboardEvent) => { if (event.key === 'Shift') held.value = true })
    useEventListener(window, 'keyup', (event: KeyboardEvent) => { if (event.key === 'Shift') held.value = false })
    useEventListener(window, 'blur', () => { held.value = false })
  }
  return held
})
