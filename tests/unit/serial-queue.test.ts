import { describe, expect, it } from 'vitest'
import { createSerialQueue } from '../../workers/serial-queue'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('serial queue', () => {
  it('finishes tasks in arrival order even when a later one is faster', async () => {
    const enqueue = createSerialQueue()
    const done: number[] = []
    await Promise.all([
      enqueue(async () => { await wait(30); done.push(1) }),
      enqueue(async () => { await wait(1); done.push(2) }),
      enqueue(async () => { done.push(3) }),
    ])
    expect(done).toEqual([1, 2, 3])
  })

  it('keeps going after a task fails', async () => {
    const enqueue = createSerialQueue()
    const failed = enqueue(async () => { throw new Error('boom') })
    const next = enqueue(async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })
})
