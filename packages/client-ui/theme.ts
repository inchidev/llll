// With a neutral primary, Nuxt UI's focus is a white ring plus a 3px white halo.
// Fields focus with a quiet grey border instead; buttons keep their own focus.
const quietFocus = { compoundVariants: [{ color: 'primary', variant: ['outline', 'subtle'], class: 'focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-(--ui-text-dimmed)' }] }
const quietFocusWithin = { compoundVariants: [{ color: 'primary', variant: ['outline', 'subtle'], class: 'focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-(--ui-text-dimmed) focus-within:ring-1 focus-within:ring-(--ui-text-dimmed)' }] }

/** Nuxt UI controls use the same neutral tokens in the Shell and Server. */
export const clientUiTheme = {
  input: quietFocus,
  textarea: quietFocus,
  select: quietFocus,
  selectMenu: quietFocus,
  inputNumber: quietFocus,
  inputMenu: quietFocusWithin,
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
