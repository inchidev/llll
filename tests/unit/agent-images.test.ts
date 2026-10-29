import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { agentImageResolver, modelAcceptsImages } from '../../server/utils/agent-images'
import type { L4Env } from '../../workers/env'

const owner = '22222222-2222-4222-8222-222222222222', other = '33333333-3333-4333-8333-333333333333'
let sqlite: DatabaseSync, env: L4Env
const bytes = new Uint8Array([137, 80, 78, 71])
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL); sqlite.exec('PRAGMA foreign_keys=OFF')
  sqlite.exec(`INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES
    ('image-own-1','m','parent','${owner}','own','a.png','image/png',4,'2026-01-01'),
    ('image-other','m','parent','${other}','other','b.png','image/png',4,'2026-01-01'),
    ('image-far-1','x','elsewhere','${owner}','far','c.png','image/png',4,'2026-01-01')`)
  sqlite.exec("INSERT INTO channels(id,type,name,parent_id,parent_message_id,created_at) VALUES('parent','text','general',NULL,NULL,'2026-01-01'),('thread','thread','t','parent','m','2026-01-01')")
  const files = { get: vi.fn(async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer })) }
  env = { DB: d1(sqlite), FILES: files } as unknown as L4Env
})
afterEach(() => sqlite.close())

it('loads only the initiator’s images from this conversation', async () => {
  const images = agentImageResolver(env, { channelId: 'thread', initiatedBy: owner }, async () => true)
  const parts = await images.parts('Look [l4-image:image-own-1] [l4-image:image-other] [l4-image:image-far-1]')
  expect(parts).toEqual([
    { type: 'text', text: 'Look ' }, { type: 'image', image: bytes, mediaType: 'image/png' }, { type: 'text', text: ' ' },
    { type: 'text', text: '[An attached image is no longer available.]' }, { type: 'text', text: ' ' },
    { type: 'text', text: '[An attached image is no longer available.]' },
  ])
  expect(await images.parts('no images')).toBe('no images')
})

it('tells a text-only model about the image instead of sending it', async () => {
  const parts = await agentImageResolver(env, { channelId: 'thread', initiatedBy: owner }, async () => false).parts('[l4-image:image-own-1]')
  expect(parts).toEqual([{ type: 'text', text: expect.stringContaining('cannot view images') }])
})

it('reads OpenRouter modalities for models saved without them', async () => {
  sqlite.exec(`INSERT INTO server_settings(key,value,updated_at) VALUES('agents.provider.openrouter','{"kind":"openrouter","name":"OpenRouter","enabled":true,"models":[{"id":"deepseek/flash","api":"chat"},{"id":"vision/known","api":"chat","images":true}]}','2026-01-01')`)
  const transport = vi.fn(async () => Response.json({ data: { architecture: { input_modalities: ['text'] } } }))
  expect(await modelAcceptsImages(env, 'l4:openrouter:deepseek/flash', transport)).toBe(false)
  expect(await modelAcceptsImages(env, 'l4:openrouter:vision/known', transport)).toBe(true)
  expect(transport).toHaveBeenCalledTimes(1)
  expect(await modelAcceptsImages(env, '@cf/meta/llama', transport)).toBe(false)
})
