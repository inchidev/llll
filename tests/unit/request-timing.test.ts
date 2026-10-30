import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { requestTiming } from '../../server/utils/request-timing'
import { getServerId } from '../../shared/server-id'
import type { L4Env } from '../../workers/env'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE t(id TEXT); INSERT INTO t VALUES('a'),('b')")
  const calls: string[] = []
  const stub = { wake: async (id: string) => { calls.push(id); return 'woken' } }
  const env = { DB: d1(db), PUBLIC_ORIGIN: 'https://team.example',
    AGENT_RUN_DO: { idFromName: (name: string) => name, getByName: () => stub } } as unknown as L4Env
  return { env, calls }
}

it('counts D1 statements and Durable Object calls without changing their results', async () => {
  const { env, calls } = fixture()
  const timing = requestTiming(env)
  expect(timing.env.PUBLIC_ORIGIN).toBe('https://team.example')
  expect(await timing.env.DB.prepare('SELECT id FROM t WHERE id=?').bind('a').first()).toEqual({ id: 'a' })
  expect((await timing.env.DB.prepare('SELECT id FROM t').all()).results).toHaveLength(2)
  await timing.env.DB.batch([timing.env.DB.prepare('SELECT 1'), timing.env.DB.prepare('SELECT 2')])
  expect(await timing.env.AGENT_RUN_DO!.getByName('run:x').wake('x')).toBe('woken')
  expect(calls).toEqual(['x'])
  expect(timing.summary()).toMatchObject({ d1: 4, doCalls: 1 })
  expect(timing.header()).toMatch(/^d1;dur=[\d.]+;desc="4 statements", d1-sql;dur=[\d.]+;desc="time inside D1", do;dur=[\d.]+;desc="1 Durable Object calls", app;dur=[\d.]+;desc="whole request"/u)
})

it('calls Durable Object RPC methods directly, never through a remote `apply`', async () => {
  const calls: string[] = []
  // Like a Workers RPC stub: every property, `apply` and `call` included, is a remote method.
  const remote = (name: string): unknown => new Proxy(async (...args: unknown[]) => { calls.push(`${name}(${args.join(',')})`); return true }, {
    get: (_target, key) => typeof key === 'string' ? remote(`${name}.${key}`) : undefined,
  })
  const stub = new Proxy({}, { get: (_target, key) => typeof key === 'string' && key !== 'then' ? remote(key) : undefined })
  const env = { RATE_LIMIT_DO: { idFromName: (name: string) => name, getByName: () => stub } } as unknown as L4Env
  const timing = requestTiming(env)
  expect(await (timing.env.RATE_LIMIT_DO.getByName('ip:x') as unknown as { take: (limit: number, windowMs: number) => Promise<boolean> }).take(5, 1000)).toBe(true)
  expect(calls).toEqual(['take(5,1000)'])
})

it('leaves the shared env untouched and marks only the first request as cold', async () => {
  const { env } = fixture()
  const first = requestTiming(env)
  const second = requestTiming(env)
  await env.DB.prepare('SELECT 1').first()
  expect(second.summary()).toMatchObject({ d1: 0, cold: false })
  expect(typeof first.summary().cold).toBe('boolean')
})

it('keeps per-isolate caches keyed on the real database', async () => {
  const { env } = fixture()
  await env.DB.prepare("CREATE TABLE server_identity(singleton INTEGER PRIMARY KEY, id TEXT)").run()
  await env.DB.prepare("INSERT INTO server_identity VALUES(1,'00000000-0000-4000-8000-000000000001')").run()
  await getServerId(env.DB)
  const timing = requestTiming(env)
  expect(await getServerId(timing.env.DB)).toBe('00000000-0000-4000-8000-000000000001')
  expect(timing.summary().d1).toBe(0)
})
