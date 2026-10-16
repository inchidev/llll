import type { H3Event } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const context = vi.hoisted(() => ({ body: {} as Record<string, unknown>, create: vi.fn() }))
vi.mock('../../../apps/admin/server/utils/session', () => ({ requireOwner: async () => ({ id: 'owner', email: 'admin@example.com' }) }))
vi.mock('../../../apps/admin/server/utils/workspaces', () => ({ createWorkspace: context.create }))
vi.mock('../../../apps/admin/server/utils/http', () => ({
  assertMutation: vi.fn(),
  adminEnv: () => ({}),
  fail: (statusCode: number, message: string) => { throw Object.assign(new Error(message), { statusCode }) },
  progressStream: (_event: unknown, work: (report: () => void) => unknown) => work(() => {}),
}))
beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('readBody', async () => context.body)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => { context.create.mockClear() })

async function create(body: Record<string, unknown>) {
  context.body = { appName: 'Team', workerName: 'team', ...body }
  const { default: handler } = await import('../../../apps/admin/server/api/workspaces.post')
  return handler({} as H3Event)
}

describe('workspace owner selection', () => {
  it.each([undefined, true])('uses the authenticated Admin email for a workspace for me (%s)', async (forMyself) => {
    await create({ forMyself, ownerEmail: 'someone-else@example.com' })
    expect(context.create.mock.calls[0]?.[1]).toMatchObject({ ownerEmail: 'admin@example.com' })
  })
  it('passes the chosen other owner to workspace provisioning', async () => {
    await create({ forMyself: false, ownerEmail: ' Customer@Example.com ' })
    expect(context.create.mock.calls[0]?.[1]).toMatchObject({ ownerEmail: 'customer@example.com' })
  })
  it.each([undefined, '', 'invalid', 42])('refuses a missing or invalid other-owner email (%s) before provisioning', async (ownerEmail) => {
    await expect(create({ forMyself: false, ownerEmail })).rejects.toMatchObject({ statusCode: 400 })
    expect(context.create).not.toHaveBeenCalled()
  })
  it('refuses an ambiguous owner choice', async () => {
    await expect(create({ forMyself: 'false', ownerEmail: 'customer@example.com' })).rejects.toMatchObject({ statusCode: 400 })
    expect(context.create).not.toHaveBeenCalled()
  })
})
