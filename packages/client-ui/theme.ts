/** Nuxt UI controls use the same neutral tokens in the Shell and Server. */
export const clientUiTheme = {
  colors: { primary: 'neutral', neutral: 'neutral' },
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
