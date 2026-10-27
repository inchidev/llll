import { expect, it, vi } from 'vitest'
import { findD1Database } from '../../scripts/cloudflare-d1.mjs'

const firstPage = Array.from({ length: 100 }, (_, index) => ({ name: `llll-pr-${index}`, uuid: `preview-${index}` }))

it('finds the existing production UUID after a full page when D1 supplies total_count without total_pages', async () => {
  const target = { name: 'llll', uuid: 'existing-production' }
  const api = vi.fn(async (path: string) => {
    const page = Number(new URL(path, 'https://cf.invalid').searchParams.get('page'))
    return { result: page === 1 ? firstPage : [target], result_info: { page, per_page: 100, total_count: 101 } }
  })
  expect(await findD1Database(api, 'llll')).toEqual(target)
  expect(api).toHaveBeenCalledTimes(2)
  for (const [path] of api.mock.calls) expect(new URL(path, 'https://cf.invalid').searchParams.get('name')).toBe('llll')
})

it('uses exact names even when the provider name filter also returns prefixes', async () => {
  const api = vi.fn(async () => ({ result: [{ name: 'llll-copy', uuid: 'other' }, { name: 'llll', uuid: 'original' }], result_info: { total_count: 2 } }))
  expect(await findD1Database(api, 'llll')).toMatchObject({ uuid: 'original' })
  expect(api.mock.calls[0]).toEqual(['/d1/database?name=llll&per_page=100&page=1'])
})

it('paginates full result arrays when a caller has no envelope metadata', async () => {
  const api = vi.fn().mockResolvedValueOnce({ result: firstPage }).mockResolvedValueOnce({ result: [{ name: 'llll-server-pr-900', uuid: 'isolated' }] })
  expect(await findD1Database(api, 'llll-server-pr-900')).toMatchObject({ uuid: 'isolated' })
  expect(api).toHaveBeenCalledTimes(2)
})

it('finishes a complete missing-name search without any resource mutation', async () => {
  const api = vi.fn().mockResolvedValueOnce({ result: firstPage, result_info: { total_count: 113, per_page: 100 } }).mockResolvedValueOnce({ result: [], result_info: { total_count: 113, per_page: 100 } })
  expect(await findD1Database(api, 'missing')).toBeUndefined()
  expect(api).toHaveBeenCalledTimes(2)
  expect(api.mock.calls.every(call => call.length === 1)).toBe(true)
})

it('supports total_pages metadata and rejects malformed lists instead of reporting a missing database', async () => {
  const api = vi.fn().mockResolvedValueOnce({ result: [], result_info: { total_pages: 2 } }).mockResolvedValueOnce({ result: [{ name: 'llll', uuid: 'existing' }] })
  expect(await findD1Database(api, 'llll')).toMatchObject({ uuid: 'existing' })
  await expect(findD1Database(async () => ({ result: null }), 'llll')).rejects.toThrow()
})
