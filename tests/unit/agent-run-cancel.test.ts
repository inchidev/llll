import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const state = vi.hoisted(() => ({ status: 'running', owner: false, actor: 'initiator', cancel: vi.fn() }))
vi.mock('../../server/utils/agent-run-service', () => ({ findAgentRun: async () => ({ id: 'run', channelId: 'chat', initiatedBy: 'initiator', status: state.status }) }))
vi.mock('../../server/utils/guards', () => ({ requireChannelAccess: async () => ({ user: { id: state.actor }, isOwner: state.owner, perms: 0 }) }))
vi.mock('../../server/utils/cf', () => ({ cf: () => ({ env: { AGENT_RUN_DO: { getByName: () => ({ cancel: state.cancel }) } } }), asRpc: (v: unknown) => v, fail: (statusCode: number, code: string, message: string) => { throw Object.assign(Error(message), { statusCode, code }) } }))
beforeEach(() => {
  state.status = 'running'; state.actor = 'initiator'; state.owner = false
  state.cancel.mockReset().mockImplementation(async () => { state.status = 'cancelled' })
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn); vi.stubGlobal('getRouterParam', () => 'run')
})
afterEach(() => vi.unstubAllGlobals())
async function cancel() { return (await import('../../server/api/agent-runs/[id]/cancel.post')).default({} as H3Event) }
it.each(['completed', 'failed', 'cancelled'])('rejects cancellation of a %s run without invoking the coordinator', async status => {
  state.status = status
  await expect(cancel()).rejects.toMatchObject({ statusCode: 409, code: 'run_finished' })
  expect(state.cancel).not.toHaveBeenCalled()
})
it.each(['queued', 'running'])('confirms a %s run actually became cancelled', async status => {
  state.status = status
  await expect(cancel()).resolves.toEqual({ status: 'cancelled' })
})
it('reports a completion racing the cancel RPC', async () => {
  state.cancel.mockImplementation(async () => { state.status = 'completed' })
  await expect(cancel()).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('completed') })
})
it('does not claim success when the coordinator made no state change', async () => {
  state.cancel.mockImplementation(async () => {})
  await expect(cancel()).rejects.toMatchObject({ statusCode: 409 })
})
it('checks authorization before disclosing the finished state', async () => {
  state.actor = 'other'; state.status = 'completed'
  await expect(cancel()).rejects.toMatchObject({ statusCode: 403 })
  expect(state.cancel).not.toHaveBeenCalled()
})
