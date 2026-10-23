import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { getServerId } from '../../shared/server-id'
import { serverAppearance, serverIconUrl } from '../../shared/server-appearance'

type FixtureEvent = { request: Request; headers: Headers; status: number }
const origin = 'https://fixture.example.com'
let sqlite: DatabaseSync
let id: string
let db: D1Database
const files = new Map<string, { body: Uint8Array; httpMetadata: { contentType: string }; httpEtag: string }>()
const getFile = vi.fn(async (key: string) => files.get(key) || null)
let discovery: (event: H3Event) => unknown
let icon: (event: H3Event) => unknown

beforeAll(async () => {
  for (const [name, fn] of Object.entries({
    defineEventHandler: (handler: unknown) => handler,
    createError: (data: {statusCode: number; statusMessage: string}) => Object.assign(new Error(data.statusMessage), data),
    getRequestURL: (event: FixtureEvent) => new URL(event.request.url),
    getHeader: (event: FixtureEvent, name: string) => event.request.headers.get(name),
    setHeader: (event: FixtureEvent, name: string, value: string) => event.headers.set(name, value),
    setResponseStatus: (event: FixtureEvent, status: number) => { event.status = status },
  })) vi.stubGlobal(name, fn)
  discovery = (await import('../../server/routes/.well-known/llll.get')).default
  icon = (await import('../../server/routes/.well-known/llll/icon.get')).default
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  db = { ...d1(sqlite), exec: async (sql: string) => { sqlite.exec(sql) } } as D1Database
  id = await getServerId(db)
  sqlite.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES ('initial_name','L4-Four','2026-10-20T00:00:00.000Z')").run()
  files.clear(); getFile.mockClear()
})
afterEach(() => sqlite.close())
async function request(path = '/.well-known/llll', headers: Record<string, string> = {}) {
  const event = { context: { cloudflare: { env: { DB: db, PUBLIC_ORIGIN: origin, FILES: { get: getFile } } } }, request: new Request(origin + path, { headers }), headers: new Headers(), status: 200 }
  try {
    const body = await (path.split('?')[0] === '/.well-known/llll' ? discovery : icon)(event as unknown as H3Event)
    return body instanceof Uint8Array ? new Response(body, { status: event.status, headers: event.headers }) : body === null ? new Response(null, { status: event.status, headers: event.headers }) : Response.json(body, { status: event.status, headers: event.headers })
  } catch (error) { return Response.json({}, { status: (error as {statusCode?:number}).statusCode || 500, headers: event.headers }) }
}
function setup() {
  sqlite.prepare("INSERT INTO users(id,display_name) VALUES ('owner','Owner')").run()
  sqlite.prepare("INSERT INTO server(id,name,owner_id) VALUES (?,'abra cadabra','owner')").run(id)
}

it('uses deployment branding only before setup, then publishes current DB name and a bounded public icon URL', async () => {
  expect(await (await request()).json()).toMatchObject({ id, name: 'L4-Four', iconUrl: null, ready: false })
  setup()
  sqlite.prepare("UPDATE server SET icon_r2_key='private/key-a.png',updated_at='2026-10-20T01:00:00.000Z'").run()
  const response = await request()
  const data = await response.json()
  expect(data).toMatchObject({ id, name: 'abra cadabra', iconUrl: origin + '/.well-known/llll/icon?v=2026-10-20T01%3A00%3A00.000Z', ready: true })
  expect(JSON.stringify(data)).not.toContain('private/key-a')
  expect(JSON.stringify(data)).not.toContain('owner')
  expect(response.headers.get('cache-control')).toBe('no-store')
  sqlite.prepare("UPDATE server SET name='Renamed again',icon_r2_key=NULL,updated_at='2026-10-20T02:00:00.000Z'").run()
  expect(await (await request()).json()).toMatchObject({ id, name: 'Renamed again', iconUrl: null })
})

it('serves only the current Server icon anonymously and revalidates changes and removal', async () => {
  setup()
  files.set('key-a', { body: new Uint8Array([1]), httpMetadata: { contentType: 'image/png' }, httpEtag: '"a"' })
  files.set('key-b', { body: new Uint8Array([2]), httpMetadata: { contentType: 'image/webp' }, httpEtag: '"b"' })
  sqlite.prepare("UPDATE server SET icon_r2_key='key-a'").run()
  let response = await request('/.well-known/llll/icon?key=other-private-file')
  expect(response.status).toBe(200)
  expect(getFile).toHaveBeenLastCalledWith('key-a')
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('etag')).toBe('"a"')
  expect((await request('/.well-known/llll/icon', { 'if-none-match': '"a"' })).status).toBe(304)
  sqlite.prepare("UPDATE server SET icon_r2_key='key-b'").run()
  response = await request('/.well-known/llll/icon', { 'if-none-match': '"a"' })
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2]))
  sqlite.prepare('UPDATE server SET icon_r2_key=NULL').run()
  expect((await request('/.well-known/llll/icon', { 'if-none-match': '"b"' })).status).toBe(404)
})

it('never loads private files or third-party icons from untrusted metadata', () => {
  for (const value of ['https://evil.example/.well-known/llll/icon', '/api/files/private?token=secret', '/.well-known/llll/icon?claim=secret', 'data:image/svg+xml,hello', 'https://owner:secret@fixture.example.com/.well-known/llll/icon'])
    expect(serverIconUrl(value, origin)).toBeNull()
  const parsed = serverAppearance({ id, name: 'Community', iconUrl: '/.well-known/llll/icon?v=1', privateToken: 'secret' }, origin)
  expect(parsed).toEqual({ id, name: 'Community', iconUrl: origin + '/.well-known/llll/icon?v=1' })
})
it('uses the installer owner-setup name for an unclaimed v0.2.8 Server without initial_name', async () => {
  sqlite.exec("DELETE FROM server_settings WHERE key='initial_name'; INSERT INTO server_setup(singleton,email,token_hash,server_name,created_at,updated_at) VALUES(1,'owner@example.com','private-hash','Community name','2026-10-23','2026-10-23')")
  const discovery = await (await request()).json()
  expect(discovery).toMatchObject({ name: 'Community name', ready: false })
  expect(JSON.stringify(discovery)).not.toMatch(/owner@example|private-hash/)
})
