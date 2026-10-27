import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { checkLizardConnection, getLizardConnection, lizardCredential, removeLizardConnection, saveLizardConnection } from '../../server/utils/lizard-connection'
let f: ReturnType<typeof mcpFixture>
beforeEach(() => {
  f = mcpFixture()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'project-a', name: 'Project A', envVars: ['private-provider-data'] }])))
})
afterEach(() => { vi.unstubAllGlobals(); f.db.close() })
it('checks access and stores an encrypted key without returning it', async () => {
  const owner = await f.actor()
  expect(await checkLizardConnection(f.env, owner, 'secret-lizard-key')).toEqual({ projects: [{ id: 'project-a', name: 'Project A' }] })
  const result = await saveLizardConnection(f.env, owner, 'secret-lizard-key', 'project-a')
  expect(result.connection).toMatchObject({ projectId: 'project-a', executionAvailable: false })
  expect(JSON.stringify(result)).not.toContain('secret-lizard-key')
  const stored = f.db.prepare("SELECT value FROM server_settings WHERE key='compute.lizard.connection'").get()
  expect(JSON.stringify(stored)).not.toContain('secret-lizard-key')
  expect(await lizardCredential(f.env)).toEqual({ apiKey: 'secret-lizard-key', projectId: 'project-a' })
  await removeLizardConnection(f.env, owner)
  expect(await getLizardConnection(f.env, owner)).toEqual({ connection: null })
})
it('rejects non-owners and a project not accessible to the key', async () => {
  await expect(checkLizardConnection(f.env, await f.actor(ids.member), 'secret-lizard-key')).rejects.toMatchObject({ statusCode: 403 })
  await expect(saveLizardConnection(f.env, await f.actor(), 'secret-lizard-key', 'other-project')).rejects.toMatchObject({ statusCode: 403 })
  expect(await getLizardConnection(f.env, await f.actor())).toEqual({ connection: null })
})
it('does not save or leak a rejected credential', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream error', { status: 401 })))
  await expect(saveLizardConnection(f.env, await f.actor(), 'secret-lizard-key', 'project-a')).rejects.toMatchObject({ statusCode: 403 })
  expect(await getLizardConnection(f.env, await f.actor())).toEqual({ connection: null })
})
