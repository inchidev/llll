import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'

const created = vi.hoisted(() => [] as Array<{ agentId: string; prompt: string }>)
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
vi.mock('../../server/utils/authorization', () => ({ loadAuthorizationContext: async () => ({}) }))
vi.mock('../../workers/agent-replies', () => ({ ensureAgentReplyTarget: async () => ({ channelId: 'thread' }) }))
vi.mock('../../server/utils/agent-run-service', () => ({ createAgentRun: async (_env: unknown, _actor: unknown, input: { agentId: string; prompt: string }) => { created.push(input); return { id: 'run' } } }))

const agentId = '11111111-1111-4111-8111-111111111111'
const personId = '22222222-2222-4222-8222-222222222222'
let sqlite: DatabaseSync

async function receive(content: string, hasImages = false) {
  const { L4Agent } = await import('../../workers/llll-agent')
  const agent = new L4Agent({ id: { name: `agent:${agentId}` }, waitUntil() {} } as never, { DB: d1(sqlite) } as unknown as L4Env)
  await agent.receiveMessage({ messageId: 'm', channelId: 'chat', authorId: personId, authorName: 'Ana', content, hasImages })
  return created.at(-1)!
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL); sqlite.exec('PRAGMA foreign_keys=OFF')
  sqlite.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('${agentId}','agent','Pi','active','member','2026-01-01'),('${personId}','human','Ana','active','member','2026-01-01');`)
  created.length = 0
})
afterEach(() => sqlite.close())

it('names the Run after the Durable Object and gives the model readable mentions', async () => {
  const run = await receive(`<@${agentId}> ask <@${personId}> about the release`)
  expect(run.agentId).toBe(agentId)
  expect(run.prompt).toBe('@Pi ask @Ana about the release')
})

it('treats a bare mention as a ping instead of an empty request', async () => {
  expect((await receive(` <@${agentId}> `)).prompt).toBe('Ana mentioned you without any other text. Reply briefly and ask what they need.')
})

it('references the author’s own images and strips references typed by members', async () => {
  sqlite.exec(`INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES
    ('image-own-1','m','chat','${personId}','k1','a.png','image/png',10,'2026-01-01'),
    ('image-other','m','chat','${agentId}','k2','b.png','image/png',10,'2026-01-01'),
    ('image-pdf-1','m','chat','${personId}','k3','c.pdf','application/pdf',10,'2026-01-01')`)
  const bare = await receive(`<@${agentId}>`, true)
  expect(bare.prompt).toContain('sent an attachment')
  expect(bare.prompt).toContain('[l4-image:image-own-1]')
  expect(bare.prompt).not.toContain('image-other')
  const text = await receive('Что на фото? [l4-image:image-other]', true)
  expect(text.prompt).toBe('Что на фото? \n[l4-image:image-own-1]')
})
