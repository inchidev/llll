import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { newThreadTitle } from '../../server/utils/thread-title'
import { aiFunctionConfig, inferAiFunction } from '../../server/utils/ai-functions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
vi.mock('../../server/utils/ai-functions', () => ({ aiFunctionConfig: vi.fn(), inferAiFunction: vi.fn() }))
const actor = { principal: { id: 'member' } } as AuthorizationContext
let sqlite: DatabaseSync, env: L4Env
beforeEach(() => {
  vi.clearAllMocks()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT)')
  env = { DB: d1(sqlite) } as L4Env
})
afterEach(() => sqlite.close())
it('keeps message titles without invoking a model until explicitly enabled', async () => {
  vi.mocked(aiFunctionConfig).mockResolvedValue({ model: null })
  expect(await newThreadTitle(env, actor, 'Discuss deploy')).toBe('Discuss deploy')
  expect(inferAiFunction).not.toHaveBeenCalled()
})
it('sends only the authorized root content and filenames, without reading attachment data', async () => {
  vi.mocked(aiFunctionConfig).mockResolvedValue({ model: 'l4:chosen:title-model' })
  vi.mocked(inferAiFunction).mockResolvedValue('Release review')
  expect(await newThreadTitle(env, actor, 'Discuss deploy', ['report.pdf'])).toBe('Release review')
  expect(inferAiFunction).toHaveBeenCalledWith(env, actor, 'thread.title', expect.any(String), JSON.stringify({ message: 'Discuss deploy', filenames: ['report.pdf'] }))
})
it.each(['', 'a'.repeat(81), 'Title\nMore text', '<script>'])('rejects unusable title output: %s', async output => {
  vi.mocked(aiFunctionConfig).mockResolvedValue({ model: 'l4:chosen:title-model' })
  vi.mocked(inferAiFunction).mockResolvedValue(output)
  expect(await newThreadTitle(env, actor, 'Discuss deploy')).toBe('Discuss deploy')
})
it('keeps conversation creation available when inference or its saved configuration fails', async () => {
  vi.mocked(aiFunctionConfig).mockRejectedValueOnce(new Error('Invalid config'))
  expect(await newThreadTitle(env, actor, 'Discuss deploy')).toBe('Discuss deploy')
  vi.mocked(aiFunctionConfig).mockResolvedValue({ model: 'l4:chosen:title-model' })
  vi.mocked(inferAiFunction).mockRejectedValueOnce(new Error('Provider unavailable'))
  expect(await newThreadTitle(env, actor, 'Discuss deploy')).toBe('Discuss deploy')
})

async function backgroundFixture(run: (db: DatabaseSync, env: L4Env, auth: AuthorizationContext) => Promise<void>) {
  const { INIT_SQL } = await import('../../server/utils/db')
  const { ALL_PERMISSIONS } = await import('../../shared/permissions')
  const db = new DatabaseSync(':memory:')
  const serverId = '00000000-0000-4000-8000-000000000001'
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('role','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('member','human','Member','active','role',CURRENT_TIMESTAMP);
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Fixture','member');
    INSERT INTO channels(id,name,type,visibility) VALUES('parent','General','text','server');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('root','parent','member','Original',CURRENT_TIMESTAMP);
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread','Original','thread','server','parent','root');`)
  const auth: AuthorizationContext = { serverId, principal: { id: 'member', kind: 'human', roleId: 'role', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true }, credential: { kind: 'session' } }
  const env = { DB: d1(db), CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) } } as unknown as L4Env
  vi.mocked(aiFunctionConfig).mockResolvedValue({ model: 'l4:chosen:title-model' })
  try { await run(db, env, auth) } finally { db.close() }
}
it('stores a generated title in the background without marking the thread as new activity', async () => {
  const { updateNewThreadTitle } = await import('../../server/utils/thread-title')
  await backgroundFixture(async (db, env, auth) => {
    const before = db.prepare("SELECT updated_at FROM channels WHERE id='thread'").get()
    vi.mocked(inferAiFunction).mockResolvedValueOnce('Generated')
    await updateNewThreadTitle(env, auth, 'thread', 'Original')
    expect(db.prepare("SELECT name FROM channels WHERE id='thread'").get()).toMatchObject({ name: 'Generated' })
    expect(db.prepare("SELECT updated_at FROM channels WHERE id='thread'").get()).toEqual(before)
  })
})
it.each(['rename', 'revoke', 'delete-root'])('does not overwrite a title after %s during inference', async operation => {
  const { updateNewThreadTitle } = await import('../../server/utils/thread-title')
  await backgroundFixture(async (db, env, auth) => {
    vi.mocked(inferAiFunction).mockImplementationOnce(async () => {
      if (operation === 'rename') db.exec("UPDATE channels SET name='Manual' WHERE id='thread'")
      if (operation === 'revoke') db.exec("UPDATE users SET status='removed' WHERE id='member'")
      if (operation === 'delete-root') db.exec("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP WHERE id='root'")
      return 'Generated'
    })
    await updateNewThreadTitle(env, auth, 'thread', 'Original')
    expect(db.prepare("SELECT name FROM channels WHERE id='thread'").get()).toMatchObject({ name: operation === 'rename' ? 'Manual' : 'Original' })
  })
})
it('does not send a private root to inference after channel access is revoked', async () => {
  const { updateNewThreadTitle } = await import('../../server/utils/thread-title')
  await backgroundFixture(async (db, env, auth) => {
    db.exec("UPDATE channels SET visibility='private' WHERE id='parent'")
    await updateNewThreadTitle(env, auth, 'thread', 'Original')
    expect(inferAiFunction).not.toHaveBeenCalled()
  })
})
