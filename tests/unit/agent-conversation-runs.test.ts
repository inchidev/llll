import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
const mocks = vi.hoisted(() => ({ member: vi.fn(), channel: vi.fn(), env: {} as { DB?: D1Database } }))
vi.mock('../../server/utils/guards', () => ({ requireMember: mocks.member, requireChannelMember: mocks.channel }))
vi.mock('../../server/utils/cf', () => ({ cf: () => ({ env: mocks.env }) }))
let db: DatabaseSync
beforeEach(() => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn); vi.stubGlobal('getRouterParam', () => 'root'); vi.stubGlobal('setHeader', vi.fn())
  mocks.member.mockReset().mockResolvedValue({ user: { id: 'me' } }); mocks.channel.mockReset().mockResolvedValue({})
  db = new DatabaseSync(':memory:'); mocks.env.DB = d1(db)
  db.exec(`CREATE TABLE server_identity(singleton INTEGER PRIMARY KEY,id TEXT); INSERT INTO server_identity VALUES(1,'server');
    CREATE TABLE channels(id TEXT,parent_id TEXT);
    INSERT INTO channels VALUES('root',NULL),('thread','root'),('foreign',NULL);
    CREATE TABLE agent_runs(id TEXT,channel_id TEXT,initiated_by TEXT,prompt TEXT,agent_id TEXT,status TEXT,created_at TEXT);
    INSERT INTO agent_runs VALUES
    ('active','root','me','Working','agent','running','1'),
    ('queued','thread','me','Next','agent','queued','2'),
    ('finished','root','me','Done','agent','completed','3'),
    ('secret','foreign','me','Private canary','agent','running','4');`)
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })
it('returns current root/thread controls without a model catalog dependency or foreign runs', async () => {
  const event = {} as never
  const result = await (await import('../../server/api/channels/[id]/agent-runs.get')).default(event)
  expect(result.active.map(item => item.id)).toEqual(['active', 'queued'])
  expect(mocks.member).toHaveBeenCalledWith(event, 'server', Permission.useAgents)
  expect(mocks.channel).toHaveBeenCalledWith(event, 'root')
  expect(setHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'no-store')
})
it.each(['member', 'channel'] as const)('does not return queue data when %s authorization fails', async guard => {
  mocks[guard].mockRejectedValue(Error('Forbidden'))
  await expect((await import('../../server/api/channels/[id]/agent-runs.get')).default({} as never)).rejects.toThrow('Forbidden')
})

it('redacts another member’s queued prompt while preserving the initiator’s controls', async () => {
  db.prepare("UPDATE agent_runs SET initiated_by='other',prompt='PRIVATE_QUEUE_PROMPT' WHERE id='queued'").run()
  const result = await (await import('../../server/api/channels/[id]/agent-runs.get')).default({} as never)
  expect(result.active.find(run => run.id === 'active')?.prompt).toBe('Working')
  expect(result.active.find(run => run.id === 'queued')?.prompt).toBe('Private Run')
  expect(JSON.stringify(result)).not.toContain('PRIVATE_QUEUE_PROMPT')
})
