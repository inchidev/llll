import { describe, expect, it, vi } from 'vitest'
import { useNewRecords } from '../../app/composables/useNewRecords'
import type { DatabaseItemDTO } from '../../shared/types'

function item(id: string, title: string): DatabaseItemDTO {
  return { id, databaseId: 'db', title, values: {}, position: 0, version: 1, createdBy: 'owner', createdAt: '', updatedAt: '' } as DatabaseItemDTO
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('new records', () => {
  it('creates every typed record in order with the database and values it was typed into', async () => {
    const calls: Array<{ databaseId: string; title: string; values: object; done: ReturnType<typeof deferred<DatabaseItemDTO>> }> = []
    const onCreated = vi.fn()
    const onIdle = vi.fn()
    const records = useNewRecords((databaseId, title, values) => {
      const done = deferred<DatabaseItemDTO>()
      calls.push({ databaseId, title, values, done })
      return done.promise
    }, { onCreated, onFailed: vi.fn(), onIdle })

    records.submit('db-1', 'A', { stage: 'glob' })
    records.submit('db-1', 'B')
    // The page may switch view or database while earlier records save.
    const last = records.submit('db-2', 'C')
    expect(records.pending.value.map(record => record.title)).toEqual(['A', 'B', 'C'])

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    calls[0]!.done.resolve(item('a', 'A'))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(records.pending.value.map(record => record.title)).toEqual(['B', 'C'])
    calls[1]!.done.resolve(item('b', 'B'))
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    calls[2]!.done.resolve(item('c', 'C'))
    await last

    expect(calls.map(({ databaseId, title, values }) => ({ databaseId, title, values }))).toEqual([
      { databaseId: 'db-1', title: 'A', values: { stage: 'glob' } },
      { databaseId: 'db-1', title: 'B', values: {} },
      { databaseId: 'db-2', title: 'C', values: {} },
    ])
    expect(onCreated.mock.calls.map(([databaseId, created]) => [databaseId, created.title])).toEqual([['db-1', 'A'], ['db-1', 'B'], ['db-2', 'C']])
    expect(records.pending.value).toEqual([])
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('reports a failed record and still creates the ones typed after it', async () => {
    const onFailed = vi.fn()
    const created: string[] = []
    const records = useNewRecords(async (_databaseId, title) => {
      if (title === 'Broken') throw new Error('Conflict')
      created.push(title)
      return item(title, title)
    }, { onCreated: vi.fn(), onFailed })

    records.submit('db', 'Broken')
    await records.submit('db', 'Next')

    expect(onFailed).toHaveBeenCalledWith('Broken', expect.any(Error))
    expect(created).toEqual(['Next'])
    expect(records.pending.value).toEqual([])
  })
})
