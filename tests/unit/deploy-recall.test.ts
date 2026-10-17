import { expect, it } from 'vitest'
import { readDeployedInstallations, recordDeployedInstallation } from '../../apps/site/app/utils/deploy-recall'

function fakeStorage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next },
  }
}

it('remembers completed installations by origin, newest first', () => {
  const storage = fakeStorage()
  recordDeployedInstallation({ origin: 'https://a.test', name: 'First', completedAt: 1 }, storage)
  recordDeployedInstallation({ origin: 'https://b.test', name: 'Second', completedAt: 2 }, storage)
  const list = readDeployedInstallations(storage)
  expect(list.map(entry => entry.origin)).toEqual(['https://b.test', 'https://a.test'])
})

it('refreshes the recorded name and keeps a single entry per origin', () => {
  const storage = fakeStorage()
  recordDeployedInstallation({ origin: 'https://a.test', name: 'My L4', completedAt: 1 }, storage)
  recordDeployedInstallation({ origin: 'https://a.test', name: 'My L4', completedAt: 2 }, storage)
  expect(readDeployedInstallations(storage)).toEqual([{ origin: 'https://a.test', name: 'My L4', completedAt: 2 }])
})

it('caps the remembered list', () => {
  const storage = fakeStorage()
  for (let index = 0; index < 30; index++) recordDeployedInstallation({ origin: `https://${index}.test`, name: 'L4', completedAt: index }, storage)
  const list = readDeployedInstallations(storage)
  expect(list.length).toBe(20)
  expect(list.some(entry => entry.origin === 'https://0.test')).toBe(false)
})

it('returns an empty list for missing or corrupt storage and skips unsafe origins', () => {
  expect(readDeployedInstallations(fakeStorage(null))).toEqual([])
  expect(readDeployedInstallations(fakeStorage('not json'))).toEqual([])
  expect(readDeployedInstallations(fakeStorage('{"origin":"https://a.test"}'))).toEqual([])
  const storage = fakeStorage()
  recordDeployedInstallation({ origin: 'not a url', name: 'X', completedAt: 1 }, storage)
  recordDeployedInstallation({ origin: 'ftp://a.test', name: 'X', completedAt: 1 }, storage)
  recordDeployedInstallation({ origin: 'http://192.0.2.1', name: 'X', completedAt: 1 }, storage)
  expect(readDeployedInstallations(storage)).toEqual([])
})
