import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type Handler = (event: { data?: { json: () => unknown }; notification?: { close: () => void; data?: { url?: string } }; waitUntil: (promise: Promise<unknown>) => void }) => void

function serviceWorker(focused: boolean, closed = false) {
  const handlers = new Map<string, Handler>()
  const showNotification = vi.fn(async () => undefined)
  const openWindow = vi.fn(async () => undefined)
  const setAppBadge = vi.fn(async () => undefined), clearAppBadge = vi.fn(async () => undefined)
  const context = {
    URL,
    self: {
      location: { origin: 'https://chat.example.com' },
      registration: { showNotification },
      navigator: { setAppBadge, clearAppBadge },
      addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    },
    clients: {
      matchAll: vi.fn(async () => closed ? [] : [{ focused, visibilityState: focused ? 'visible' : 'hidden' }]),
      openWindow,
    },
  }
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), context)
  return { handlers, showNotification, openWindow, setAppBadge, clearAppBadge }
}

async function push(worker: ReturnType<typeof serviceWorker>, badgeCount?: number) {
  let pending = Promise.resolve()
  worker.handlers.get('push')!({
    data: { json: () => ({ title: 'Alice', body: 'hello', tag: 'message:1', url: '/channels/general', badgeCount }) },
    waitUntil: (promise) => { pending = promise.then(() => undefined) },
  })
  await pending
}

describe('web push foreground deduplication', () => {
  it('does not show an OS notification over a focused L4 client', async () => {
    const worker = serviceWorker(true)
    await push(worker)
    expect(worker.showNotification).not.toHaveBeenCalled()
  })

  it('still shows a notification when every client is backgrounded', async () => {
    const worker = serviceWorker(false)
    await push(worker)
    expect(worker.showNotification).toHaveBeenCalledOnce()
  })
  it('shows a notification when the app has no open windows', async () => {
    const worker = serviceWorker(false, true)
    await push(worker)
    expect(worker.showNotification).toHaveBeenCalledOnce()
  })
  it('sets the supplied count instead of incrementing it, and clears zero', async () => {
    const worker = serviceWorker(false, true)
    await push(worker, 2)
    await push(worker, 2)
    expect(worker.setAppBadge).toHaveBeenNthCalledWith(1, 2)
    expect(worker.setAppBadge).toHaveBeenNthCalledWith(2, 2)
    await push(worker, 0)
    expect(worker.clearAppBadge).toHaveBeenCalledOnce()
  })
  it('opens the Server conversation when a notification is tapped after closing the app', async () => {
    const worker = serviceWorker(false, true)
    let pending = Promise.resolve()
    worker.handlers.get('notificationclick')!({
      notification: { close: () => {}, data: { url: '/channels/general' } },
      waitUntil: promise => { pending = promise.then(() => undefined) },
    })
    await pending
    expect(worker.openWindow).toHaveBeenCalledWith('https://chat.example.com/channels/general')
  })
})
