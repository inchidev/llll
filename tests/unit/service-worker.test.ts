import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type Handler = (event: { data?: { json: () => unknown }; notification?: { close: () => void; data?: { url?: string } }; waitUntil: (promise: Promise<unknown>) => void }) => void

function serviceWorker(focused: boolean) {
  const handlers = new Map<string, Handler>()
  const showNotification = vi.fn(async () => undefined)
  const context = {
    URL,
    self: {
      location: { origin: 'https://chat.example.com' },
      registration: { showNotification },
      addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    },
    clients: {
      matchAll: vi.fn(async () => [{ focused, visibilityState: focused ? 'visible' : 'hidden' }]),
      openWindow: vi.fn(),
    },
  }
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), context)
  return { handlers, showNotification }
}

async function push(worker: ReturnType<typeof serviceWorker>) {
  let pending = Promise.resolve()
  worker.handlers.get('push')!({
    data: { json: () => ({ title: 'Alice', body: 'hello', tag: 'message:1', url: '/channels/general' }) },
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
})
