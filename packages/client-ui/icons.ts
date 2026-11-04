// This shared component lives outside both Nuxt app directories, so their icon
// scanners need its icons explicitly. Keep the rail usable without runtime fetches.
export const communityRailIcons = ['ph:plus', 'ph:dots-three', 'ph:plugs-connected', 'ph:cloud-arrow-up', 'ph:list']

/**
 * Every icon Nuxt UI draws for itself, in Phosphor. Each app bundles only what it uses and asks no icon
 * service, so a name left to Nuxt UI's default set would render blank.
 */
export const uiIcons = {
  arrowDown: 'i-ph-arrow-down',
  arrowLeft: 'i-ph-arrow-left',
  arrowRight: 'i-ph-arrow-right',
  arrowUp: 'i-ph-arrow-up',
  caution: 'i-ph-warning-circle',
  check: 'i-ph-check',
  chevronDoubleLeft: 'i-ph-caret-double-left',
  chevronDoubleRight: 'i-ph-caret-double-right',
  chevronDown: 'i-ph-caret-down',
  chevronLeft: 'i-ph-caret-left',
  chevronRight: 'i-ph-caret-right',
  chevronUp: 'i-ph-caret-up',
  close: 'i-ph-x',
  copy: 'i-ph-copy',
  copyCheck: 'i-ph-check',
  dark: 'i-ph-moon',
  drag: 'i-ph-dots-six-vertical',
  ellipsis: 'i-ph-dots-three',
  error: 'i-ph-x-circle',
  external: 'i-ph-arrow-square-out',
  eye: 'i-ph-eye',
  eyeOff: 'i-ph-eye-slash',
  file: 'i-ph-file',
  folder: 'i-ph-folder',
  folderOpen: 'i-ph-folder-open',
  hash: 'i-ph-hash',
  info: 'i-ph-info',
  light: 'i-ph-sun',
  loading: 'i-ph-spinner',
  menu: 'i-ph-list',
  minus: 'i-ph-minus',
  panelClose: 'i-ph-sidebar-simple',
  panelOpen: 'i-ph-sidebar-simple',
  plus: 'i-ph-plus',
  reload: 'i-ph-arrow-counter-clockwise',
  search: 'i-ph-magnifying-glass',
  stop: 'i-ph-stop',
  star: 'i-ph-star',
  success: 'i-ph-check-circle',
  system: 'i-ph-monitor',
  tip: 'i-ph-lightbulb',
  upload: 'i-ph-upload-simple',
  warning: 'i-ph-warning',
} as const

