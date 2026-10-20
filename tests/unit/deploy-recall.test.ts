import { expect, it } from 'vitest'
import { readDeployedServers, recordDeployedServer } from '../../shared/deploy-recall'

function fakeStorage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next },
  }
}

it('remembers completed servers by origin, newest first', () => {
  const storage = fakeStorage()
  recordDeployedServer({ origin: 'https://a.test', name: 'First', completedAt: 1 }, storage)
  recordDeployedServer({ origin: 'https://b.test', name: 'Second', completedAt: 2 }, storage)
  const list = readDeployedServers(storage)
  expect(list.map(entry => entry.origin)).toEqual(['https://b.test', 'https://a.test'])
})

it('refreshes the recorded name and keeps a single entry per origin', () => {
  const storage = fakeStorage()
  recordDeployedServer({ origin: 'https://a.test', name: 'My L4', completedAt: 1 }, storage)
  recordDeployedServer({ origin: 'https://a.test', name: 'My L4', completedAt: 2 }, storage)
  expect(readDeployedServers(storage)).toEqual([{ origin: 'https://a.test', name: 'My L4', completedAt: 2 }])
})

it('caps the remembered list', () => {
  const storage = fakeStorage()
  for (let index = 0; index < 30; index++) recordDeployedServer({ origin: `https://${index}.test`, name: 'L4', completedAt: index }, storage)
  const list = readDeployedServers(storage)
  expect(list.length).toBe(20)
  expect(list.some(entry => entry.origin === 'https://0.test')).toBe(false)
})

it('returns an empty list for missing or corrupt storage and skips unsafe origins', () => {
  expect(readDeployedServers(fakeStorage(null))).toEqual([])
  expect(readDeployedServers(fakeStorage('not json'))).toEqual([])
  expect(readDeployedServers(fakeStorage('{"origin":"https://a.test"}'))).toEqual([])
  const storage = fakeStorage()
  recordDeployedServer({ origin: 'not a url', name: 'X', completedAt: 1 }, storage)
  recordDeployedServer({ origin: 'ftp://a.test', name: 'X', completedAt: 1 }, storage)
  recordDeployedServer({ origin: 'http://192.0.2.1', name: 'X', completedAt: 1 }, storage)
  recordDeployedServer({ origin: 'https://a.test/setup#claim=private-token', name: 'X', completedAt: 1 }, storage)
  recordDeployedServer({ origin: 'https://owner:private-token@a.test', name: 'X', completedAt: 1 }, storage)
  expect(readDeployedServers(storage)).toEqual([])
})

it('remembers account metadata without retaining private handoffs', () => {
  const storage = fakeStorage()
  recordDeployedServer({ origin: 'https://a.test', name: 'Community', accountId: 'a'.repeat(32), version: '0.2.0-alpha.3', completedAt: 1, ...{ claim: 'private-claim', grant: 'private-grant' } }, storage)
  expect(readDeployedServers(storage)).toEqual([{ origin: 'https://a.test', name: 'Community', accountId: 'a'.repeat(32), version: '0.2.0-alpha.3', completedAt: 1 }])
  expect(storage.getItem('')).not.toContain('private-')
})
