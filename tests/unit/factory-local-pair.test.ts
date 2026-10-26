import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { factoryHash } from '../../server/utils/factory-authority'
import { requireComputeNode } from '../../server/utils/compute-nodes'

vi.mock('h3', async original => ({
  ...await original<typeof import('h3')>(),
  toWebRequest: (event: { request: Request }) => event.request,
}))

const origin = 'https://vps.example.com', nodeId = '00000000-0000-4000-8000-000000000090'
const token = 'a'.repeat(64), timestamp = Date.parse('2026-10-26T12:00:00Z')
const capabilities = { diskBytes: 1073741824, docker: true, durableDisk: true, isolation: 'shared-kernel',
  image: 'sha256:' + 'b'.repeat(64), maxParallel: 1, protocol: 1 }
let fixture: ReturnType<typeof mcpFixture>
const setHeader = vi.fn()

beforeEach(() => {
  fixture = mcpFixture()
  Object.assign(fixture.env, { LLLL_RUNTIME: 'celld', PUBLIC_ORIGIN: origin })
  vi.spyOn(Date, 'now').mockReturnValue(timestamp)
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('readRawBody', (event: { request: Request }) => event.request.text())
  vi.stubGlobal('getHeader', (event: { request: Request }, name: string) => event.request.headers.get(name))
  setHeader.mockReset()
  vi.stubGlobal('setHeader', setHeader)
})
afterEach(() => { fixture.db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const payload = (extra: Record<string, unknown> = {}) => ({ nodeId, token, timestamp, capabilities, ...extra })
function sign(raw: string, signedOrigin = origin, secret = fixture.env.AUTH_SECRET!) {
  return createHmac('sha256', secret).update('l4-local-compute-v1\n' + signedOrigin + '\n' + raw).digest('hex')
}
async function request(input = payload(), options: { raw?: string; signature?: string | null; signedOrigin?: string; secret?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(input)
  const signature = options.signature === null ? undefined : options.signature ?? sign(raw, options.signedOrigin, options.secret)
  const webRequest = new Request(origin + '/api/compute-agent/local-pair', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-L4-Local-Signature': signature } : {}) }, body: raw })
  const event = { request: webRequest, context: { cloudflare: { env: fixture.env, request: webRequest } } }
  return (await import('../../server/api/compute-agent/local-pair.post')).default(event as never)
}
const nodes = () => fixture.db.prepare('SELECT id,token_hash,capabilities_json,enabled,created_by FROM compute_nodes ORDER BY id').all()

it('pairs one local executor using the trusted host signature, hashes its token and returns only this Server identity', async () => {
  const roles = fixture.db.prepare('SELECT id,permissions_bitmask FROM roles ORDER BY id').all()
  expect(await request()).toEqual({ serverId: ids.server })
  expect(nodes()).toEqual([expect.objectContaining({ id: nodeId, token_hash: await factoryHash(token), capabilities_json: JSON.stringify(capabilities), enabled: 1, created_by: ids.owner })])
  expect(JSON.stringify(nodes())).not.toContain(token)
  expect(await requireComputeNode(fixture.env, token)).toEqual({ id: nodeId })
  expect(fixture.db.prepare('SELECT id,permissions_bitmask FROM roles ORDER BY id').all()).toEqual(roles)
  expect(setHeader).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'private, no-store')
})
it.each([null, '', 'not-a-signature', 'a'.repeat(63), 'f'.repeat(64)])('rejects a missing, malformed or forged host signature: %s', async signature => {
  await expect(request(payload(), { signature })).rejects.toMatchObject({ statusCode: 403 })
  expect(nodes()).toEqual([])
})
it('binds the signature to the intended Server origin, exact request bytes and current host secret', async () => {
  await expect(request(payload(), { signedOrigin: 'https://another-server.example' })).rejects.toMatchObject({ statusCode: 403 })
  await expect(request(payload(), { secret: 'another-server-secret-at-least-32-characters' })).rejects.toMatchObject({ statusCode: 403 })
  const raw = JSON.stringify(payload()), signature = sign(raw)
  await expect(request(payload(), { raw: raw + '\n', signature })).rejects.toMatchObject({ statusCode: 403 })
  await expect(request(payload({ token: 'c'.repeat(64) }), { signature })).rejects.toMatchObject({ statusCode: 403 })
  expect(nodes()).toEqual([])
})
it.each([-60001, 60001])('rejects expired or future pairing timestamps outside the authorization window: %i ms', async skew => {
  await expect(request(payload({ timestamp: timestamp + skew }))).rejects.toMatchObject({ statusCode: 403 })
  expect(nodes()).toEqual([])
})
it.each([-60000, 60000])('accepts a valid pairing at the bounded timestamp edge: %i ms', async skew => {
  expect(await request(payload({ timestamp: timestamp + skew }))).toEqual({ serverId: ids.server })
})
it('requires a claimed Owner before creating a Node and permits the same signed intent after the Owner claim', async () => {
  fixture.db.prepare('DELETE FROM server').run()
  const input = payload()
  await expect(request(input)).rejects.toMatchObject({ statusCode: 409 })
  expect(nodes()).toEqual([])
  fixture.db.prepare('INSERT INTO server(id,name,owner_id) VALUES(?,?,?)').run(ids.server, 'Claimed VPS', ids.owner)
  expect(await request(input)).toEqual({ serverId: ids.server })
  expect(nodes()).toHaveLength(1)
})
it.each(['cloudflare', 'workers', undefined])('denies local host pairing on non-VPS placement %s even with a valid signature', async runtime => {
  fixture.env.LLLL_RUNTIME = runtime
  await expect(request()).rejects.toMatchObject({ statusCode: 403 })
  expect(nodes()).toEqual([])
})
it('reconciles a repeated signed pairing without creating another Node or rotating its credential', async () => {
  const input = payload()
  expect(await request(input)).toEqual({ serverId: ids.server })
  const before = nodes()
  expect(await request(input)).toEqual({ serverId: ids.server })
  expect(nodes()).toEqual(before)
  await expect(request(payload({ token: 'c'.repeat(64) }))).rejects.toMatchObject({ statusCode: 409 })
  expect(nodes()).toEqual(before)
})
it('does not revive a disabled local executor through a replayed installation intent', async () => {
  await request()
  fixture.db.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').run(nodeId)
  await expect(request()).rejects.toMatchObject({ statusCode: 409 })
  expect(nodes()).toEqual([expect.objectContaining({ id: nodeId, enabled: 0 })])
  await expect(requireComputeNode(fixture.env, token)).rejects.toMatchObject({ statusCode: 403 })
})
it('preserves an existing remote Node while adding the local VPS executor', async () => {
  const remoteId = '00000000-0000-4000-8000-000000000091'
  fixture.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,created_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(remoteId, 'Existing remote Node', await factoryHash('remote-token'), JSON.stringify({ ...capabilities, image: 'registry.example/workspace@sha256:' + 'd'.repeat(64) }), ids.owner, new Date().toISOString())
  const before = nodes()[0]
  await request()
  expect(nodes()).toHaveLength(2)
  expect(nodes().find(node => node.id === remoteId)).toEqual(before)
  expect(await requireComputeNode(fixture.env, 'remote-token')).toEqual({ id: remoteId })
})
it.each(['AUTH_SECRET', 'PUBLIC_ORIGIN'] as const)('requires the local Server signing configuration %s', async key => {
  const signed = sign(JSON.stringify(payload()))
  Reflect.deleteProperty(fixture.env, key)
  await expect(request(payload(), { signature: signed })).rejects.toMatchObject({ statusCode: 403 })
  expect(nodes()).toEqual([])
})
it('refuses an oversized request before creating or changing compute state', async () => {
  await expect(request(payload(), { raw: 'x'.repeat(4097), signature: 'f'.repeat(64) })).rejects.toMatchObject({ statusCode: 413 })
  expect(nodes()).toEqual([])
})
it.each([
  { token: 'short' }, { nodeId: '../other-server' },
  { capabilities: { ...capabilities, image: 'workspace:latest' } },
  { capabilities: { ...capabilities, diskBytes: 0, durableDisk: false } },
  { authorizedOwner: ids.owner },
])('validates a signed pairing intent before allocating a Node: %j', async invalid => {
  await expect(request(payload(invalid))).rejects.toThrow()
  expect(nodes()).toEqual([])
})

it('requires a new pairing identity when the released workspace image or declared capabilities change', async () => {
  await request()
  const before = nodes()
  const changed = { ...capabilities, image: 'sha256:' + 'c'.repeat(64) }
  const rejected = await request(payload({ capabilities: changed })).catch(error => error)
  expect(rejected).toMatchObject({ statusCode: 409 })
  expect(JSON.stringify(rejected)).not.toContain(token)
  expect(nodes()).toEqual(before)
  expect(await requireComputeNode(fixture.env, token)).toEqual({ id: nodeId })
})

it('cancels an oversized streaming body before waiting for its completion or checking a signature', async () => {
  const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4097)) }, cancel })
  const webRequest = new Request(origin + '/api/compute-agent/local-pair', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  const event = { request: webRequest, context: { cloudflare: { env: fixture.env, request: webRequest } } }
  const handler = (await import('../../server/api/compute-agent/local-pair.post')).default
  await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 413 })
  expect(cancel).toHaveBeenCalledOnce()
  expect(nodes()).toEqual([])
}, 2000)
