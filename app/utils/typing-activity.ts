export const TYPING_REFRESH_MS = 1800
export const TYPING_IDLE_MS = 2500

type Timer = ReturnType<typeof setTimeout>

export function createTypingActivity(
  emit: (active: boolean) => void,
  options: {
    now?: () => number
    setTimer?: (callback: () => void, delay: number) => Timer
    clearTimer?: (timer: Timer) => void
  } = {},
) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay) as Timer)
  const clearTimer = options.clearTimer ?? clearTimeout
  let active = false
  let lastPulse = 0
  let idleTimer: Timer | null = null

  function stop() {
    if (idleTimer) clearTimer(idleTimer)
    idleTimer = null
    if (!active) return
    active = false
    emit(false)
  }

  function input() {
    const time = now()
    if (!active || time - lastPulse >= TYPING_REFRESH_MS) {
      active = true
      lastPulse = time
      emit(true)
    }
    if (idleTimer) clearTimer(idleTimer)
    idleTimer = setTimer(stop, TYPING_IDLE_MS)
  }

  return { input, stop }
}
