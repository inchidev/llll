import { invoke } from '@tauri-apps/api/core'
import { fetch } from '@tauri-apps/plugin-http'
import { mountServerList } from '../../../packages/native-shell/server-list'

const titlebar = document.createElement('div')
titlebar.dataset.tauriDragRegion = ''
titlebar.setAttribute('aria-hidden', 'true')
titlebar.style.cssText = 'position:fixed;inset:0 0 auto 0;height:2.25rem;z-index:1'
document.body.prepend(titlebar)

mountServerList({
  async readDiscovery(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, connectTimeout: 7000 })
    return { status: response.status, data: response.status === 200 ? await response.json() : null }
  },
  // Native notifications are granted to this Server's origin only.
  beforeOpen: origin => invoke('allow_server', { origin }),
  onServersChanged: (servers) => { void invoke('sync_servers', { servers }).catch(() => undefined) },
  takePendingUrl: () => invoke<string | null>('pending_page'),
})
