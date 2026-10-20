import { version } from '../package.json'
import { clientUiTheme } from '../packages/client-ui/theme'

export default defineAppConfig({
  version,
  ui: {
    ...clientUiTheme,
    // Solid alerts read as alarms; the tinted style is the house default.
    alert: {
      defaultVariants: {
        variant: 'subtle',
      },
    },
    // Dialog actions sit on the right, primary last.
    modal: {
      slots: {
        footer: 'flex-wrap justify-end gap-2',
      },
      // The default elevated scrim lightens a dark page; dim it instead.
      variants: {
        overlay: {
          true: { overlay: 'bg-black/60' },
        },
      },
    },
    slideover: {
      variants: {
        overlay: {
          true: { overlay: 'bg-black/60' },
        },
      },
    },
    icons: {
      loading: 'i-ph-spinner',
      close: 'i-ph-x',
      check: 'i-ph-check',
      chevronDown: 'i-ph-caret-down',
      chevronRight: 'i-ph-caret-right',
      chevronLeft: 'i-ph-caret-left',
      chevronUp: 'i-ph-caret-up',
      arrowLeft: 'i-ph-arrow-left',
      arrowRight: 'i-ph-arrow-right',
      search: 'i-ph-magnifying-glass',
      external: 'i-ph-arrow-square-out',
      plus: 'i-ph-plus',
      minus: 'i-ph-minus',
      ellipsis: 'i-ph-dots-three',
    },
  },
})
