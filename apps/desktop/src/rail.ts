import { invoke } from '@tauri-apps/api/core'
import { mountRail } from '../../../packages/native-shell/rail'

// The window's controls sit over the top of this page, as they do over a Server's Client.
document.documentElement.style.setProperty('--top', '2.25rem')
const dragRegion = document.createElement('div')
dragRegion.dataset.tauriDragRegion = ''
dragRegion.style.cssText = 'position:fixed;inset:0 0 auto 0;height:2.25rem'
document.body.prepend(dragRegion)

mountRail({
  open: (origin) => { void invoke('rail_open', { origin }) },
  showList: () => { void invoke('rail_list') },
  ready: () => { void invoke<string | null>('rail_active').then(origin => window.__L4_RAIL__?.setActive(origin)) },
})
