import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
const mocks = vi.hoisted(() => ({ channel: vi.fn(), env: {} as Record<string, unknown> }))
vi.mock('../../server/utils/guards', () => ({ requireChannelAccess: mocks.channel }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: mocks.env }) }))
let f: ReturnType<typeof mcpFixture>, id: string
let read: ReturnType<typeof vi.fn>
beforeEach(async () => {
  f = mcpFixture()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id IN (?,?)').run(ALL_PERMISSIONS, ids.agentRole, ids.memberRole)
  const { run } = await f.run(ids.member); id = run.id
  f.db.prepare("UPDATE agent_runs SET status='completed',result_text='PRIVATE_RESULT',files_key='private-files' WHERE id=?").run(id)
  read = vi.fn(async () => ({ size: 100, body: new ReadableStream(), text: async () => 'PRIVATE_ARCHIVE' }))
  Object.assign(mocks.env, f.env, { FILES: { get: read } })
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => id)
  vi.stubGlobal('setHeader', vi.fn())
  mocks.channel.mockReset()
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
const handlers = async () => [
  (await import('../../server/api/agent-runs/[id].get')).default,
  (await import('../../server/api/agent-runs/[id]/transcript.get')).default,
  (await import('../../server/api/agent-runs/[id]/files.get')).default,
]
async function as(actorId: string) {
  const authorization = await f.actor(actorId)
  mocks.channel.mockResolvedValue({ user: { id: actorId }, authorization, isOwner: actorId === ids.owner, perms: ALL_PERMISSIONS })
}
it('permits the initiating Member’s body, final text, transcript and working files under current grants', async () => {
  await as(ids.member)
  const [body, transcript, files] = await handlers()
  expect(await body!({} as never)).toMatchObject({ run: { resultText: 'PRIVATE_RESULT' } })
  await transcript!({} as never); await files!({} as never)
  expect(read).toHaveBeenCalledTimes(2)
  expect(setHeader).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'private, no-store')
})
it('denies Owner access to another initiator’s body, final text, transcript and files before reading storage', async () => {
  await as(ids.owner)
  for (const handler of await handlers()) await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'private_run' } } })
  expect(read).not.toHaveBeenCalled()
})
it('denies a different Member even with broad permissions; identity is not a Role grant', async () => {
  const other = '00000000-0000-4000-8000-000000000099'
  f.db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES(?,'human','Other Member','active',?,'2026-10-25')").run(other, ids.memberRole)
  await as(other)
  for (const handler of await handlers()) await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403 })
  expect(read).not.toHaveBeenCalled()
})
