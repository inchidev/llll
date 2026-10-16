export default defineAppConfig({
  ui: {
    colors: {
      primary: 'cloudflare',
      neutral: 'neutral',
    },
    alert: {
      defaultVariants: {
        variant: 'subtle',
      },
    },
    modal: {
      slots: {
        footer: 'justify-end',
      },
    },
    icons: {
      loading: 'i-ph-spinner',
      close: 'i-ph-x',
      check: 'i-ph-check',
      chevronDown: 'i-ph-caret-down',
      chevronRight: 'i-ph-caret-right',
      chevronLeft: 'i-ph-caret-left',
      arrowLeft: 'i-ph-arrow-left',
      arrowRight: 'i-ph-arrow-right',
      external: 'i-ph-arrow-square-out',
    },
  },
})
