import { serverInitials } from '../../shared/server-initials'
import { lastServerKey, readBookmarks } from './server-list'

// The app's Server rail. It runs in its own WebView at the app's own address, beside the one showing
// a Server, so a Server's page can reach neither this page nor the list it reads.
export type RailHost = {
  open: (origin: string) => void
  showList: () => void
  /** Says the page is up, so the app can tell it which Server is on screen. */
  ready: () => void
}

declare global {
  interface Window { __L4_RAIL__?: { setActive: (origin: string | null) => void } }
}

export function mountRail(host: RailHost) {
  const list = document.querySelector<HTMLUListElement>('#servers')!
  let active: string | null = null

  function render() {
    list.textContent = ''
    for (const server of readBookmarks()) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'server'
      button.title = server.name
      button.setAttribute('aria-label', server.name)
      if (server.origin === active) button.setAttribute('aria-current', 'page')
      if (server.iconUrl) {
        const icon = document.createElement('img')
        icon.src = server.iconUrl
        icon.alt = ''
        button.append(icon)
      }
      else button.textContent = serverInitials(server.name)
      button.addEventListener('click', () => {
        if (server.origin === active) return
        localStorage.setItem(lastServerKey, server.origin)
        host.open(server.origin)
      })
      item.append(button)
      list.append(item)
    }
  }

  for (const id of ['list', 'add']) document.querySelector(`#${id}`)!.addEventListener('click', () => host.showList())
  window.__L4_RAIL__ = { setActive(origin) { active = origin; render() } }
  window.addEventListener('storage', render)
  render()
  host.ready()
}
