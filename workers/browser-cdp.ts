const NAVIGATION_TIMEOUT_MS = 15_000

export type CdpEvent = {
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

export type CdpClient = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>
  waitFor: (predicate: (event: CdpEvent) => boolean, timeoutMs: number) => Promise<void>
  close: () => Promise<void>
}

type BrowserAction = 'markdown' | 'screenshot' | 'links'

const PAGE_TEXT = `(() => { const root = document.querySelector('article, main') || document.body; return root ? root.innerText : '' })()`
const PAGE_LINKS = `Array.from(document.querySelectorAll('a[href]')).map((node) => node.href).filter(Boolean).slice(0, 50)`

export async function resolveCdpWebSocketUrl(cdpUrl: string, fetcher: typeof fetch = fetch): Promise<string> {
  const trimmed = cdpUrl.trim()
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed
  let base: URL
  try {
    base = new URL(trimmed)
  }
  catch {
    throw new Error('BROWSER_CDP_URL must be an http(s) DevTools endpoint or a ws(s) browser socket')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('BROWSER_CDP_URL must be an http(s) DevTools endpoint or a ws(s) browser socket')
  }
  const versionUrl = new URL('/json/version', base)
  const response = await fetcher(versionUrl)
  if (!response.ok) throw new Error(`Chromium DevTools endpoint returned ${response.status}`)
  const body = await response.json() as { webSocketDebuggerUrl?: string }
  if (!body.webSocketDebuggerUrl) throw new Error('Chromium DevTools endpoint did not return a websocket URL')
  return body.webSocketDebuggerUrl
}

export async function chromiumQuickAction(client: CdpClient, action: BrowserAction, url: string): Promise<Response> {
  const created = await client.send('Target.createTarget', { url: 'about:blank' }) as { targetId?: string }
  const targetId = created.targetId
  if (!targetId) throw new Error('Chromium did not open a page')
  try {
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string }
    const sessionId = attached.sessionId
    if (!sessionId) throw new Error('Chromium did not attach to the page')
    await client.send('Page.enable', {}, sessionId)
    await client.send('Page.navigate', { url }, sessionId)
    try {
      await client.waitFor(event => event.method === 'Page.loadEventFired' && event.sessionId === sessionId, NAVIGATION_TIMEOUT_MS)
    }
    catch {
      // A page that never finishes loading can still have readable text.
    }
    if (action === 'screenshot') {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data?: string }
      if (!shot.data) throw new Error('Chromium screenshot was empty')
      const bytes = Uint8Array.from(atob(shot.data), char => char.charCodeAt(0))
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    const evaluated = await client.send('Runtime.evaluate', {
      expression: action === 'links' ? PAGE_LINKS : PAGE_TEXT,
      returnByValue: true,
    }, sessionId) as { result?: { value?: unknown }, exceptionDetails?: { text?: string } }
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || 'Chromium could not read the page')
    if (action === 'links') {
      const links = Array.isArray(evaluated.result?.value)
        ? evaluated.result.value.filter((item): item is string => typeof item === 'string')
        : []
      return Response.json({ result: links })
    }
    const markdown = typeof evaluated.result?.value === 'string' ? evaluated.result.value : ''
    return Response.json({ result: markdown })
  }
  finally {
    await client.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
}

export async function connectCdp(webSocketUrl: string): Promise<CdpClient> {
  const socket = new WebSocket(webSocketUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium DevTools socket timed out')), 10_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Chromium DevTools socket failed'))
    }, { once: true })
  })

  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  const events: CdpEvent[] = []
  const waiters = new Set<(event: CdpEvent) => void>()

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : ''
    let message: CdpEvent & { id?: number, result?: unknown, error?: { message?: string } }
    try {
      message = JSON.parse(raw) as typeof message
    }
    catch {
      return
    }
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message || 'Chromium DevTools request failed'))
      else waiter.resolve(message.result)
      return
    }
    events.push(message)
    for (const waiter of waiters) waiter(message)
  })

  return {
    send(method, params, sessionId) {
      const id = nextId
      nextId += 1
      const payload: { id: number, method: string, params?: Record<string, unknown>, sessionId?: string } = { id, method }
      if (params) payload.params = params
      if (sessionId) payload.sessionId = sessionId
      socket.send(JSON.stringify(payload))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
    },
    waitFor(predicate, timeoutMs) {
      const existing = events.find(predicate)
      if (existing) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(onEvent)
          reject(new Error('Chromium page did not finish loading'))
        }, timeoutMs)
        const onEvent = (event: CdpEvent) => {
          if (!predicate(event)) return
          clearTimeout(timer)
          waiters.delete(onEvent)
          resolve()
        }
        waiters.add(onEvent)
      })
    },
    async close() {
      for (const waiter of pending.values()) waiter.reject(new Error('Chromium DevTools socket closed'))
      pending.clear()
      socket.close()
    },
  }
}

export function chromiumBrowser(cdpUrl: string): {
  quickAction: (action: BrowserAction, options: { url: string }) => Promise<Response>
} {
  return {
    async quickAction(action, options) {
      const socketUrl = await resolveCdpWebSocketUrl(cdpUrl)
      const client = await connectCdp(socketUrl)
      try {
        return await chromiumQuickAction(client, action, options.url)
      }
      finally {
        await client.close()
      }
    },
  }
}
