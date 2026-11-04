import { beforeEach, expect, it, vi } from 'vitest'
import { ACTION_RATE_LIMITS } from '../../shared/spaces'

const state = vi.hoisted(() => ({ body: {} as Record<string, unknown>, limit: vi.fn(async () => {}), create: vi.fn(async () => ({ id: 'new' })) }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({ user: { id: 'sam' }, authorization: { spaces: { ids: ['sales'], active: 'sales', denied: {} } } }) }))
vi.mock('../../server/utils/cf', () => ({ cf: () => ({ env: {} }), fail: () => { throw new Error('fail') } }))
vi.mock('../../server/utils/item-service', () => ({ createItem: state.create }))
vi.mock('../../server/utils/route-gate', () => ({ enforceActionLimit: state.limit }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => 'server')
  vi.stubGlobal('readBody', async () => state.body)
})

it('counts an Item created in a Database as a record, in the Space it lands in', async () => {
  state.body = { databaseId: 'db', title: 'Row' }
  const { default: handler } = await import('../../server/api/servers/[id]/items.post')
  await (handler as (event: unknown) => Promise<unknown>)({})
  expect(state.limit).toHaveBeenCalledExactlyOnceWith({}, 'record.create', 'sam', 'sales')
  expect(ACTION_RATE_LIMITS['record.create']).toBeDefined()
  expect(state.create).toHaveBeenCalledOnce()
})

it('leaves a page outside a Database out of the record limit', async () => {
  state.body = { title: 'Page' }
  const { default: handler } = await import('../../server/api/servers/[id]/items.post')
  await (handler as (event: unknown) => Promise<unknown>)({})
  expect(state.limit).not.toHaveBeenCalled()
  expect(state.create).toHaveBeenCalledOnce()
})
