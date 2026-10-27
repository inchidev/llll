import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture } from '../helpers/outbound-mcp'
import { saveLizardConnection } from '../../server/utils/lizard-connection'
import { createLizardSandbox, deleteLizardSandbox } from '../../server/utils/lizard-sandboxes'
let f: ReturnType<typeof mcpFixture>
beforeEach(async () => {
  f = mcpFixture()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'project-a', name: 'Project A' }])))
  await saveLizardConnection(f.env, await f.actor(), 'secret-lizard-key', 'project-a')
})
afterEach(() => { vi.unstubAllGlobals(); f.db.close() })
it('creates a bounded VM in the connected project and attaches workspace identity', async () => {
  const fetcher = vi.fn(async () => Response.json({ sandboxId: 'test-sandbox' }))
  vi.stubGlobal('fetch', fetcher)
  const result = await createLizardSandbox(f.env, { workspaceId: 'b5949476-1a4e-4141-bfc6-a72a7751fd95', timeoutMs: 600000, region: 'us-east-1', size: 'small' })
  expect(result).toEqual({ sandboxId: 'test-sandbox' })
  const [url, init] = fetcher.mock.calls[0]!
  expect(url).toBe('https://lizard.build/api/sandboxes')
  expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ projectId: 'project-a', timeoutMs: 600000, metadata: { l4Workspace: 'b5949476-1a4e-4141-bfc6-a72a7751fd95' } })
})
it('does not retry unknown outcomes and handles missing VMs during cleanup', async () => {
  const fetcher = vi.fn(async () => { throw Error('token is secret-lizard-key') })
  vi.stubGlobal('fetch', fetcher)
  await expect(createLizardSandbox(f.env, { workspaceId: 'b5949476-1a4e-4141-bfc6-a72a7751fd95', timeoutMs: 600000, region: 'us-east-1', size: 'small' })).rejects.toMatchObject({ statusCode: 503 })
  expect(fetcher).toHaveBeenCalledTimes(1)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
  expect(await deleteLizardSandbox(f.env, 'gone-sandbox', 'b5949476-1a4e-4141-bfc6-a72a7751fd95')).toEqual({ deleted: true })
})
it('never deletes a VM belonging to a different workspace', async () => {
  const fetcher = vi.fn(async () => Response.json({ metadata: { l4Workspace: 'another-workspace' } }))
  vi.stubGlobal('fetch', fetcher)
  await expect(deleteLizardSandbox(f.env, 'other-sandbox', 'b5949476-1a4e-4141-bfc6-a72a7751fd95')).rejects.toMatchObject({ statusCode: 403 })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
