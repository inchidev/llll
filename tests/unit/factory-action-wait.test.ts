import { expect, it, vi } from 'vitest'
import { factoryActionSettled } from '../../server/utils/agent-tools'
import type { L4Env } from '../../workers/env'

function db(statuses: Array<string | null>) {
  const first = vi.fn(async () => { const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!; return status ? { status } : null })
  return { env: { DB: { prepare: () => ({ bind: () => ({ first }) }) } } as unknown as L4Env, first }
}

it('holds a Factory poll until the Node finishes the action', async () => {
  vi.useFakeTimers()
  try {
    const { env, first } = db(['approved', 'claimed', 'executing', 'completed'])
    const settled = factoryActionSettled(env, 'run', 'call')
    await vi.advanceTimersByTimeAsync(2000)
    await settled
    expect(first).toHaveBeenCalledTimes(4)
  } finally { vi.useRealTimers() }
})

it('returns at once for an action that waits for a person, and stops at its time limit', async () => {
  vi.useFakeTimers()
  try {
    const pending = db(['pending'])
    await factoryActionSettled(pending.env, 'run', 'call')
    expect(pending.first).toHaveBeenCalledTimes(1)
    const stuck = db(['executing'])
    const settled = factoryActionSettled(stuck.env, 'run', 'call', undefined, 2000)
    await vi.advanceTimersByTimeAsync(3000)
    await settled
    expect(stuck.first.mock.calls.length).toBeLessThanOrEqual(5)
  } finally { vi.useRealTimers() }
})
