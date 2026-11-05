import { afterEach, expect, it, vi } from 'vitest'
import { databasePlacement, placementBeside } from '../../../packages/deployment-core/src/placement'

afterEach(() => vi.unstubAllGlobals())

const answering = (response: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => response()))

it('runs a Worker beside its database, by data center first and then by region', () => {
  expect(placementBeside({ served_by_colo: 'KIX', served_by_region: 'APAC' })).toEqual({ region: 'aws:ap-northeast-3' })
  expect(placementBeside({ served_by_colo: 'MEL', served_by_region: 'OC' })).toEqual({ region: 'aws:ap-southeast-2' })
  expect(placementBeside({ served_by_colo: 'XXX', served_by_region: 'APAC' })).toEqual({ region: 'aws:ap-southeast-1' })
})

it('leaves the choice to Smart Placement when D1 does not say where it is', () => {
  expect(placementBeside()).toEqual({ mode: 'smart' })
  expect(placementBeside({ served_by_colo: 'XXX', served_by_region: 'MOON' })).toEqual({ mode: 'smart' })
})

it('asks D1 where the database is', async () => {
  answering(() => Response.json({ success: true, result: [{ results: [{ 1: 1 }], meta: { served_by_colo: 'SIN', served_by_region: 'APAC' } }] }))
  await expect(databasePlacement('token', 'account', 'database')).resolves.toEqual({ region: 'aws:ap-southeast-1' })
  const [url, init] = vi.mocked(fetch).mock.calls[0]!
  expect(String(url)).toContain('/accounts/account/d1/database/database/query')
  expect(init?.body).toBe(JSON.stringify({ sql: 'SELECT 1' }))
})

it('never stops an install or an update over it', async () => {
  answering(() => Response.json({ success: false, errors: [{ message: 'denied' }] }, { status: 403 }))
  await expect(databasePlacement('token', 'account', 'database')).resolves.toEqual({ mode: 'smart' })
})
