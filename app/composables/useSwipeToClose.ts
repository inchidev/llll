import { useIsMobile } from './useIsMobile'

const AXIS_LOCK_PX = 10
const SETTLE_MS = 180

/** Whether a press starts on something that needs the horizontal swipe for itself. */
export function keepsHorizontalSwipe(target: EventTarget | null) {
  let node = target instanceof Element ? target : null
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      if (node.dataset.noDrawerSwipe !== undefined) return true
      if (node.scrollWidth > node.clientWidth + 1) {
        const overflow = getComputedStyle(node).overflowX
        if (overflow === 'auto' || overflow === 'scroll') return true
      }
    }
    node = node.parentElement
  }
  return false
}

/** Far enough, or a quick flick that way. A flick back keeps the panel open. */
export function swipeCloses(dx: number, velocity: number, width: number) {
  return Math.abs(velocity) > 0.4 ? velocity > 0 : dx > width / 3
}

/**
 * On a phone, a panel over the page closes when swiped to the right and follows the finger.
 * Bind the result with `v-on` inside the panel: it moves the closest `aside` or dialog.
 */
export function useSwipeToClose(close: () => void) {
  const isMobile = useIsMobile()
  let gesture: { x: number, y: number, t: number, panel: HTMLElement, axis: 'x' | 'y' | null } | null = null

  function reset(panel: HTMLElement) {
    panel.style.transition = ''
    panel.style.transform = ''
  }

  return {
    touchstart(event: TouchEvent) {
      if (!isMobile.value || event.touches.length !== 1) return
      // The navigation drawer under this panel must not take the same swipe.
      event.stopPropagation()
      const panel = (event.currentTarget as Element).closest<HTMLElement>('aside, [role="dialog"]')
      const target = event.target
      if (!panel || keepsHorizontalSwipe(target)) return
      if (target instanceof Element && target.closest('input[type="range"], [role="slider"], [contenteditable="true"], [contenteditable="true"] *')) return
      const touch = event.touches[0]!
      gesture = { x: touch.clientX, y: touch.clientY, t: performance.now(), panel, axis: null }
    },
    touchmove(event: TouchEvent) {
      if (!gesture) return
      const touch = event.touches[0]!
      const dx = touch.clientX - gesture.x
      const dy = touch.clientY - gesture.y
      if (!gesture.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
        gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.2 && dx > 0 ? 'x' : 'y'
        if (gesture.axis === 'y') {
          gesture = null
          return
        }
      }
      gesture.panel.style.transition = 'none'
      gesture.panel.style.transform = `translateX(${Math.max(0, dx)}px)`
    },
    touchend(event: TouchEvent) {
      if (!gesture) return
      const { panel, x, t, axis } = gesture
      gesture = null
      if (!axis) return
      const dx = (event.changedTouches[0]?.clientX ?? x) - x
      const closes = swipeCloses(dx, dx / Math.max(1, performance.now() - t), panel.offsetWidth)
      panel.style.transition = `transform ${SETTLE_MS}ms ease-out`
      panel.style.transform = closes ? 'translateX(100%)' : ''
      setTimeout(() => {
        if (closes) close()
        // A panel that stays mounted while closed must not come back off to the side.
        reset(panel)
      }, SETTLE_MS)
    },
    touchcancel() {
      if (!gesture) return
      reset(gesture.panel)
      gesture = null
    },
  }
}
