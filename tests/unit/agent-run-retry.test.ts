import { afterEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const state = vi.hoisted(() => ({ actorId: 'other-member', create: vi.fn(async () => ({ id: 'new-run' })) }))
vi.mock('../../server/utils/agent-run-service', () => ({
  findAgentRun: async () => ({ id: 'old-run', initiatedBy: 'initiator', channelId: 'chat', status: 'failed', prompt: 'Private instruction', agentId: 'agent' }),
  createAgentRun: state.create,
}))
vi.mock('../../server/utils/guards', () => ({ requireChannelAccess: async () => ({ user: { id: state.actorId }, isOwner: true, authorization: { principal: { id: state.actorId } } }) }))
vi.mock('../../server/utils/cf', () => ({ cf: () => ({ env: {} }), fail: (statusCode: number) => { throw Object.assign(Error('Forbidden'), { statusCode }) } }))
afterEach(() => { vi.unstubAllGlobals(); state.create.mockClear() })
async function retry(actorId: string) {
  state.actorId = actorId
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => 'old-run')
  vi.stubGlobal('readBody', async () => ({ requestId: '00000000-0000-4000-8000-000000000001' }))
  return (await import('../../server/api/agent-runs/[id]/retry.post')).default({} as H3Event)
}
it('denies retrying another member’s prompt even to a Server owner', async () => {
  await expect(retry('other-member')).rejects.toMatchObject({ statusCode: 403 })
  expect(state.create).not.toHaveBeenCalled()
})
it('readmits the initiator under their current authorization', async () => {
  await expect(retry('initiator')).resolves.toMatchObject({ run: { id: 'new-run' } })
  expect(state.create).toHaveBeenCalledWith({}, { principal: { id: 'initiator' } }, expect.objectContaining({ prompt: 'Private instruction' }))
})
