import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import type { H3Event } from 'h3'

const state = vi.hoisted(() => ({
  route: vi.fn(),
  unroute: vi.fn(),
  batch: vi.fn(),
  removeData: vi.fn(),
  rows: [] as Array<Record<string, unknown> | null>,
  body: { domainId: 'domain', localPart: 'Hello', displayName: 'Hello', access: [] },
}))
vi.mock('../../server/utils/server-infrastructure', () => ({
  ensureManagedMailboxRoute: state.route,
  removeManagedMailboxRoute: state.unroute,
  failServerControl: (error: unknown) => { throw error },
}))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({ ownerId: 'owner', isOwner: true, user: { id: 'owner' }, authorization: {} }) }))
vi.mock('../../server/utils/cf', () => ({
  cf: () => ({ env: { DB: { prepare: () => ({ bind: () => ({ first: async () => state.rows.shift() ?? null, run: async () => undefined }) }) } } }),
  fail: (statusCode: number, code: string, message: string) => { throw Object.assign(new Error(message), { statusCode, code }) },
}))
vi.mock('../../server/utils/db', () => ({ getDb: () => ({ batch: state.batch, insert: () => ({ values: (value: unknown) => value }) }) }))
vi.mock('../../server/utils/server-mail', () => ({ ensureServerMailFromEnv: async () => undefined, replaceMailboxAccess: async () => undefined }))
vi.mock('../../server/utils/messages', () => ({ writeAudit: async () => undefined }))
vi.mock('../../server/utils/mail-cleanup', () => ({ removeMailboxData: state.removeData, cleanMailFiles: async () => 0 }))

beforeEach(() => {
  Object.values(state).forEach(value => { if (typeof value === 'function') value.mockReset() })
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => 'id')
  vi.stubGlobal('readBody', async () => state.body)
  vi.stubGlobal('setResponseStatus', () => undefined)
})
afterEach(() => vi.unstubAllGlobals())

const create = async () => (await import('../../server/api/servers/[id]/mailboxes.post')).default({} as H3Event)
const remove = async () => (await import('../../server/api/servers/[id]/mailboxes/[channelId].delete')).default({} as H3Event)

it('routes a new mailbox to this Server', async () => {
  state.rows = [{ id: 'domain', domain: 'example.com', zone_id: 'zone' }, null]
  await expect(create()).resolves.toHaveProperty('channelId')
  expect(state.route).toHaveBeenCalledWith(expect.anything(), 'zone', 'hello@example.com')
  expect(state.batch).toHaveBeenCalledOnce()
})

it('creates no mailbox when the address cannot be routed here', async () => {
  state.rows = [{ id: 'domain', domain: 'example.com', zone_id: 'zone' }, null]
  state.route.mockRejectedValue(Object.assign(new Error('hello@example.com already has a Cloudflare Email Routing rule'), { statusCode: 409 }))
  await expect(create()).rejects.toMatchObject({ statusCode: 409 })
  expect(state.batch).not.toHaveBeenCalled()
})

it('removes the route with the mailbox, and a refusal does not keep the mailbox', async () => {
  state.rows = [{ address: 'hello@example.com', zone_id: 'zone', spaceId: DEFAULT_SPACE_ID }]
  state.unroute.mockRejectedValue(new Error('Cloudflare is down'))
  await expect(remove()).resolves.toBeNull()
  expect(state.unroute).toHaveBeenCalledWith(expect.anything(), 'zone', 'hello@example.com')
  expect(state.removeData).toHaveBeenCalledOnce()
})
