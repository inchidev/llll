import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { L4Env } from '../../workers/env'
import { liveMedia } from '../../workers/live-media'
import { RealtimeKitRestProvisioner } from '../../workers/realtimekit-rest'

const accountId = 'a'.repeat(32)
const apiToken = 't'.repeat(40)
let sqlite: DatabaseSync
let env: L4Env
let provisioner: RealtimeKitRestProvisioner
let apps: Array<{ id: string; name: string }>
let presets: Set<string>
let nextMeetingStatus: number
let nextPresetStatus: number
let missingMeeting: boolean
let appNumber: number
let requests: Array<{ path: string; method: string; token: string | null }>

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE server_identity (singleton INTEGER PRIMARY KEY, id TEXT);
    INSERT INTO server_identity VALUES (1, '11111111-1111-4111-8111-111111111111');
  `)
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const stmt = {
        bind(...args: SQLInputValue[]) { values = args; return stmt },
        async first() { return sqlite.prepare(sql).get(...values) ?? null },
        async run() { return sqlite.prepare(sql).run(...values) },
      }
      return stmt
    },
  }
  env = {
    DB: db,
    LLLL_RUNTIME: 'celld',
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    SERVER_DO: { getByName(name: string) {
      expect(name).toBe('server:11111111-1111-4111-8111-111111111111')
      return { restRealtimeKitApp: (failed?: string) => provisioner.get(failed) }
    } },
  } as unknown as L4Env
  provisioner = new RealtimeKitRestProvisioner(env)
  apps = []; presets = new Set(); requests = []; appNumber = 0
  nextMeetingStatus = 200; nextPresetStatus = 200; missingMeeting = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    requests.push({ path, method, token: new Headers(init?.headers).get('Authorization') })
    const json = (result: unknown, status = 200) => Response.json({ result }, { status })
    if (path.endsWith('/apps')) {
      // Yield during provisioning so concurrent requests can actually interleave.
      await new Promise(resolve => setTimeout(resolve, 1))
      if (method === 'GET') return json(apps)
      const app = { id: `app-${++appNumber}`, name: 'L4' }
      apps.push(app)
      return json(app)
    }
    const currentApp = apps.find(app => path.includes(`/kit/${app.id}/`))
    if (!currentApp) return json(null, 404)
    if (path.endsWith('/presets')) {
      if (nextPresetStatus !== 200) {
        const status = nextPresetStatus; nextPresetStatus = 200
        return json(null, status)
      }
      if (method === 'GET') return json([...presets].map(name => ({ name })))
      presets.add(JSON.parse(String(init?.body)).name)
      return json({})
    }
    if (path.endsWith('/meetings') && method === 'POST') {
      const status = nextMeetingStatus; nextMeetingStatus = 200
      return json({ id: 'meeting-1' }, status)
    }
    if (path.endsWith('/participants') && method === 'POST') {
      const preset = JSON.parse(String(init?.body)).preset_name
      if (missingMeeting || !presets.has(preset)) return json(null, 404)
      return json({ id: 'participant-1', token: 'participant-token' })
    }
    return json({})
  }))
})

afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

function provisioningRequests() {
  return requests.filter(r => r.path.endsWith('/apps') || r.path.endsWith('/presets'))
}

async function media() {
  const result = await liveMedia(env)
  if (!result) throw new Error('Missing media')
  return result
}

const seat = { name: 'Alice', customId: 'alice', host: true }

it('provisions once for concurrent rooms and reuses persisted metadata after a coordinator restart', async () => {
  const rooms = await Promise.all(Array.from({ length: 8 }, () => media()))
  expect(apps).toHaveLength(1)
  expect(provisioningRequests()).toHaveLength(5)
  provisioner = new RealtimeKitRestProvisioner(env)
  requests = []
  const restarted = await media()
  await restarted.createMeeting('room')
  await restarted.addParticipant('meeting-1', seat)
  await restarted.removeParticipants('meeting-1', ['participant-1'])
  await restarted.endMeeting('meeting-1')
  await rooms[0]!.createMeeting('another room')
  expect(provisioningRequests()).toHaveLength(0)
})

it('restores a deleted app once on concurrent 404s and uses its new id for subsequent seats', async () => {
  const rooms = await Promise.all([media(), media()])
  apps = []; presets.clear(); requests = []
  await Promise.all(rooms.map(room => room.createMeeting('room')))
  expect(requests.filter(r => r.path.endsWith('/apps') && r.method === 'POST')).toHaveLength(1)
  expect(apps[0]?.id).toBe('app-2')
  await rooms[0]!.addParticipant('meeting-1', seat)
  expect(requests.at(-1)?.path).toContain('/kit/app-2/')
})

it('repairs a missing preset without creating another app', async () => {
  const room = await media()
  presets.delete('llll_live_host'); requests = []
  await expect(room.addParticipant('meeting-1', seat)).resolves.toMatchObject({ id: 'participant-1' })
  expect(requests.filter(r => r.path.endsWith('/apps'))).toHaveLength(0)
  expect(requests.filter(r => r.path.endsWith('/presets') && r.method === 'POST')).toHaveLength(1)
})

it('does not create an app for a missing meeting or replay a seat into a replacement app', async () => {
  const room = await media()
  missingMeeting = true; requests = []
  await expect(room.addParticipant('gone', seat)).rejects.toMatchObject({ status: 404 })
  expect(requests.filter(r => r.path.endsWith('/apps'))).toHaveLength(0)
  apps = []; requests = []
  await expect(room.addParticipant('gone', seat)).rejects.toMatchObject({ status: 404 })
  expect(requests.filter(r => r.path.endsWith('/participants'))).toHaveLength(1)
})

it.each([401, 403, 429, 500])('does not re-provision or retry a meeting write after HTTP %s', async (status) => {
  const room = await media()
  nextMeetingStatus = status; requests = []
  await expect(room.createMeeting('room')).rejects.toMatchObject({ status })
  expect(requests).toHaveLength(1)
})

it('does not persist failed provisioning and allows a later attempt', async () => {
  nextPresetStatus = 503
  await expect(media()).rejects.toMatchObject({ status: 503 })
  expect(sqlite.prepare('SELECT * FROM server_settings').all()).toHaveLength(0)
  await media()
  expect(apps).toHaveLength(1)
  expect(sqlite.prepare('SELECT * FROM server_settings').all()).toHaveLength(1)
})

it('uses a rotated token without re-provisioning and scopes saved apps to the account', async () => {
  await media(); requests = []
  env.CLOUDFLARE_API_TOKEN = 'r'.repeat(40)
  await (await media()).createMeeting('room')
  expect(provisioningRequests()).toHaveLength(0)
  expect(requests[0]?.token).toBe(`Bearer ${'r'.repeat(40)}`)
  env.CLOUDFLARE_ACCOUNT_ID = 'b'.repeat(32)
  await media()
  expect(provisioningRequests().length).toBeGreaterThan(0)
  const saved = sqlite.prepare('SELECT value FROM server_settings').all()
  expect(saved).toHaveLength(2)
  expect(JSON.stringify(saved)).not.toContain(apiToken)
  expect(JSON.stringify(saved)).not.toContain('r'.repeat(40))
})

it('does not provision on leave or end, including a missing remote meeting', async () => {
  const room = await media(); requests = []
  apps = []
  await room.removeParticipants('gone', ['participant-1'])
  await expect(room.endMeeting('gone')).rejects.toMatchObject({ status: 404 })
  expect(provisioningRequests()).toHaveLength(0)
})
