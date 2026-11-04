import { version } from '../package.json'
import { clientUiTheme } from '../packages/client-ui/theme'
import { uiIcons } from '../packages/client-ui/icons'

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
      slots: {
        header: 'pt-[max(1rem,var(--df-safe-area-top))]',
        // Long titles stop short of the close button.
        wrapper: 'pe-10',
        close: 'top-[max(1rem,var(--df-safe-area-top))]',
      },
      variants: {
        overlay: {
          true: { overlay: 'bg-black/60' },
        },
      },
    },
    icons: uiIcons,
  },
})
