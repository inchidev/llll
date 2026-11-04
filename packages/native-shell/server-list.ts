import { serverDiscovery } from '../../shared/server-discovery'
import { normalizeServerOrigin } from '../../shared/client-router'

// Device-local Server bookmarks for the native apps. A bookmark grants no
// membership: each Server opens its own Client at its own origin, which owns
// login and sessions.
type Bookmark = { origin: string; id: string; name: string; iconUrl?: string | null }

export type ServerListOptions = {
  /** Reads a Server's discovery document, through the app's native HTTP client. */
  readDiscovery: (url: string) => Promise<{ status: number; data: unknown }>
  /** Prepares the app before a Server's page loads. */
  beforeOpen?: (origin: string) => Promise<void>
  /** Tells the app's share sheet which Servers this device has. */
  onServersChanged?: (servers: Bookmark[]) => void
  /** A page to open first instead of the last Server, such as marking a recording just shared. */
  takePendingUrl?: () => Promise<string | null>
  /** Reads a QR code with the camera, on apps that have one. Null when the person cancels. */
  scanCode?: () => Promise<string | null>
}

/** A code may hold a link to any page of a Server; only its origin is the address. */
export function serverAddressFromCode(code: string) {
  const value = code.trim()
  try { return /^https?:\/\//iu.test(value) ? new URL(value).origin : value }
  catch { return value }
}

const serversKey = 'llll.native.servers'
export const lastServerKey = 'llll.native.last-server'
const lastKey = lastServerKey

export function readBookmarks(): Bookmark[] {
  try {
    const value = JSON.parse(localStorage.getItem(serversKey) || '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is Bookmark => typeof item?.origin === 'string' && typeof item?.id === 'string') : []
  }
  catch {
    return []
  }
}

export function mountServerList(options: ServerListOptions) {
  function write(servers: Bookmark[]) {
    localStorage.setItem(serversKey, JSON.stringify(servers))
    options.onServersChanged?.(servers)
  }

  async function discover(address: string): Promise<Bookmark> {
    const origin = normalizeServerOrigin(address)
    const response = await options.readDiscovery(origin + '/.well-known/llll')
    if (response.status !== 200) throw new Error('Server is unavailable')
    const data = serverDiscovery(typeof response.data === 'string' ? JSON.parse(response.data) : response.data, origin)
    return { origin: data.origin, id: data.id, name: data.name, iconUrl: data.iconUrl }
  }

  async function open(origin: string) {
    localStorage.setItem(lastKey, origin)
    await options.beforeOpen?.(origin)
    // Coming back through history must land on the list, not reopen the Server.
    history.replaceState(null, '', '#servers')
    window.location.assign(origin + '/')
  }

  function showError(cause: unknown) {
    error.textContent = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Could not connect to this Server'
  }

  function render() {
    const list = document.querySelector<HTMLUListElement>('#servers')!
    const servers = readBookmarks()
    // Not replaceChildren: it needs Chrome 86, and this page must still show on a phone with an older WebView.
    list.textContent = ''
    list.append(...servers.map((server) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.className = 'server'
      button.type = 'button'
      const icon = document.createElement(server.iconUrl ? 'img' : 'span')
      icon.className = 'icon'
      if (icon instanceof HTMLImageElement) { icon.src = server.iconUrl!; icon.alt = '' }
      else icon.textContent = server.name.slice(0, 1).toUpperCase()
      const label = document.createElement('span')
      label.className = 'label'
      const name = document.createElement('strong')
      name.textContent = server.name
      const host = document.createElement('small')
      host.textContent = new URL(server.origin).host
      label.append(name, host)
      button.append(icon, label)
      button.addEventListener('click', () => { void open(server.origin).catch(showError) })
      const remove = document.createElement('button')
      remove.className = 'remove'
      remove.type = 'button'
      remove.textContent = 'Remove'
      remove.setAttribute('aria-label', `Remove ${server.name}`)
      remove.addEventListener('click', () => {
        confirmText.textContent = `Remove ${server.name} from this device?`
        confirmRemove.returnValue = 'cancel'
        confirmRemove.addEventListener('close', () => {
          if (confirmRemove.returnValue !== 'remove') return
          write(readBookmarks().filter(item => item.id !== server.id))
          if (localStorage.getItem(lastKey) === server.origin) localStorage.removeItem(lastKey)
          render()
        }, { once: true })
        confirmRemove.showModal()
      })
      item.append(button, remove)
      return item
    }))
    document.querySelector<HTMLElement>('#empty')!.hidden = servers.length > 0
  }

  const confirmRemove = document.querySelector<HTMLDialogElement>('#confirm-remove')!
  const confirmText = document.querySelector<HTMLElement>('#confirm-remove-text')!
  const form = document.querySelector<HTMLFormElement>('#add')!
  const input = form.querySelector<HTMLInputElement>('input')!
  const submit = form.querySelector<HTMLButtonElement>('button')!
  const error = document.querySelector<HTMLElement>('#error')!

  async function add(address: string) {
    error.textContent = ''
    submit.disabled = true
    try {
      const server = await discover(address)
      write([...readBookmarks().filter(item => item.id !== server.id && item.origin !== server.origin), server])
      input.value = ''
      await open(server.origin)
    }
    catch (cause) {
      showError(cause)
    }
    finally {
      submit.disabled = false
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void add(input.value)
  })

  const { scanCode } = options
  if (scanCode) {
    const scan = document.querySelector<HTMLButtonElement>('#scan')!
    scan.hidden = false
    scan.addEventListener('click', async () => {
      error.textContent = ''
      scan.disabled = true
      try {
        const code = await scanCode()
        if (code) await add(serverAddressFromCode(code))
      }
      catch (cause) {
        showError(cause)
      }
      finally {
        scan.disabled = false
      }
    })
  }

  render()

  options.onServersChanged?.(readBookmarks())

  // A bookmark is a copy: a Server's name and picture can change after it was added.
  for (const saved of readBookmarks()) {
    void discover(saved.origin).then((fresh) => {
      if (fresh.id !== saved.id || (fresh.name === saved.name && fresh.iconUrl === saved.iconUrl)) return
      write(readBookmarks().map(item => item.id === saved.id ? { ...item, name: fresh.name, iconUrl: fresh.iconUrl } : item))
      render()
    }).catch(() => undefined)
  }

  // A launch reopens the last Server; #servers keeps the list on screen.
  async function restore() {
    const pending = await options.takePendingUrl?.().catch(() => null)
    if (pending) {
      // A page of a Server, or one of the app's own such as the marking page.
      if (/^https?:/u.test(pending)) await options.beforeOpen?.(new URL(pending).origin)
      history.replaceState(null, '', '#servers')
      window.location.assign(pending)
      return
    }
    const last = localStorage.getItem(lastKey)
    if (location.hash !== '#servers' && last && readBookmarks().some(server => server.origin === last)) await open(last)
  }
  void restore().catch(showError)
}
