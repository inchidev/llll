import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture } from '../helpers/outbound-mcp'
import { Permission } from '../../shared/permissions'

const access = vi.hoisted(() => ({ owner: true, required: 0 }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async (_event: unknown, _server: string, permission: number) => { access.required = permission; return { isOwner: access.owner } } }))
let f: ReturnType<typeof mcpFixture>
beforeEach(() => {
  f = mcpFixture()
  access.owner = true
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => '00000000-0000-4000-8000-000000000001')
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
it('counts server resources for the owner', async () => {
  const handler = (await import('../../server/api/servers/[id]/overview.get')).default
  const result = await handler({ context: { cloudflare: { env: f.env } } } as never)
  expect(access.required).toBe(Permission.manageServer)
  expect(result.totals).toMatchObject({ people: 2, agents: 1, channels: 1, projects: 0, tasks: 0 })
})
it('does not expose server-wide totals to a non-owner', async () => {
  access.owner = false
  const handler = (await import('../../server/api/servers/[id]/overview.get')).default
  await expect(handler({ context: { cloudflare: { env: f.env } } } as never)).rejects.toMatchObject({ statusCode: 403 })
})
