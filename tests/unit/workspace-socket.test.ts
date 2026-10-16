import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, toValue } from 'vue'
import type { useWorkspaceSocket as WorkspaceSocketFactory } from '../../app/composables/useWorkspaceSocket'

type Listener = (event?: { data?: string }) => void

class FakeTarget {
  listeners = new Map<string, Listener[]>()

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener))
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

class FakeWebSocket extends FakeTarget {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []

  constructor(public readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  message(message: unknown) {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(message) })
    }
  }
}

const mounted: Array<() => void> = []
const unmounted: Array<() => void> = []
const fakeWindow = new FakeTarget()
const fakeDocument = Object.assign(new FakeTarget(), {
  hidden: false,
  hasFocus: () => true,
  title: 'L4',
})
let useWorkspaceSocket: typeof WorkspaceSocketFactory

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeAll(async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('toValue', toValue)
  vi.stubGlobal('watch', (_source: unknown, callback: () => void, options?: { immediate?: boolean }) => {
    if (options?.immediate) callback()
    return () => {}
  })
  vi.stubGlobal('onMounted', (callback: () => void) => mounted.push(callback))
  vi.stubGlobal('onUnmounted', (callback: () => void) => unmounted.push(callback))
  vi.stubGlobal('usePresenceStore', () => ({ apply: vi.fn() }))
  vi.stubGlobal('usePrefsStore', () => ({ showOnline: true }))
  vi.stubGlobal('useAttention', () => ({ notifyActivity: vi.fn(), sync: vi.fn() }))
  vi.stubGlobal('useNuxtApp', () => ({ $queryClient: undefined }))
  vi.stubGlobal('useApi', () => ({
    api: vi.fn(async () => ({ token: 'test-token' })),
    socketUrl: (path: string) => `ws://localhost:3000${path}`,
  }))
  ;({ useWorkspaceSocket } = await import('../../app/composables/useWorkspaceSocket'))
})

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  fakeWindow.listeners.clear()
  fakeDocument.listeners.clear()
  mounted.length = 0
  unmounted.length = 0
})

describe('workspace presence activity', () => {
  it('does not turn an untouched visible client into fresh activity on a timer', async () => {
    const connection = useWorkspaceSocket(ref('main'))
    await flush()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message({ t: 'hello', workspaceId: 'main' })
    for (const callback of mounted) callback()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(socket.sent.map(JSON.parse).filter(message => message.t === 'activity')).toEqual([])
    for (const callback of unmounted) callback()
    connection.disconnect()
  })

  it('reports real pointer activity immediately', async () => {
    const connection = useWorkspaceSocket(ref('main'))
    await flush()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message({ t: 'hello', workspaceId: 'main' })
    for (const callback of mounted) callback()

    fakeWindow.emit('pointerdown')

    expect(socket.sent.map(JSON.parse)).toContainEqual({ t: 'activity', visible: true })
    for (const callback of unmounted) callback()
    connection.disconnect()
  })
})
