import { afterEach, expect, it, vi } from 'vitest'
const leave = vi.hoisted(() => vi.fn(async () => ({ active: true, meetingId: 'private-canary', participantIds: ['private-member'] })))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: 'outsider' }) }))
vi.mock('../../server/utils/cf', () => ({ cf: () => ({ env: {} }) }))
vi.mock('../../server/utils/live', () => ({ liveRoom: () => ({ leaveLive: leave }) }))
afterEach(() => vi.unstubAllGlobals())
it('never returns private room metadata to a caller who may have lost access', async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn); vi.stubGlobal('getRouterParam', () => 'private')
  const response = await (await import('../../server/api/channels/[id]/live/leave.post')).default({} as never)
  expect(response).toEqual({ ok: true })
  expect(JSON.stringify(response)).not.toContain('private-canary')
  expect(leave).toHaveBeenCalledWith('outsider')
})
