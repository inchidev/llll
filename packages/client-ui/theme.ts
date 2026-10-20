/** Nuxt UI controls use the same neutral tokens in the Shell and Server. */
export const clientUiTheme = {
  colors: { primary: 'neutral', neutral: 'neutral' },
  button: {
    slots: { base: 'min-h-6' },
  },
  switch: {
    slots: {
      base: 'min-h-6 data-[state=unchecked]:border-(--ui-text-dimmed)',
      container: 'min-h-6',
      thumb: 'shadow-none data-[state=unchecked]:bg-(--ui-text-muted)',
    },
  },
  tabs: {
    variants: {
      variant: {
        pill: {
          list: 'l4-segmented-track',
          indicator: 'hidden',
          trigger: 'l4-segmented-item',
        },
      },
    },
  },
}
