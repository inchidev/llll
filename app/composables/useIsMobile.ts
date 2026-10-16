import { useMounted, useWindowSize } from '@vueuse/core'

/**
 * Phone layout: one pane at a time with the navigation in a drawer.
 *
 * Server rendering cannot know the viewport, and production hydration keeps
 * mismatched class and style attributes. So this stays false until the component
 * is mounted and then switches with a normal update. Layout that must be right on
 * the very first paint uses CSS breakpoints instead.
 */
export function useIsMobile() {
  const mounted = useMounted()
  const { width } = useWindowSize()
  return computed(() => mounted.value && width.value > 0 && width.value < 768)
}
