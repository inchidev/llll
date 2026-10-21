import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createUpdateStore } from '../../shared/server-update-store'
import { changeUpdateRecord } from '../../shared/server-updates'

it('uses the same atomic SQL for first creation and stale-revision rejection across two clients', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(readFileSync(new URL('../../drizzle/server-migrations/0001_server_updates.sql', import.meta.url), 'utf8'))
    const client = () => createUpdateStore(async (sql, params) => database.prepare(sql).all(...params) as { payload: string; revision: number }[])
    const owner = client(), build = client()
    const first = await owner.read(), duplicate = await build.read()
    expect(first.revision).toBeNull()
    expect(await owner.write(first.value, first.revision)).toBe(true)
    expect(await build.write(duplicate.value, duplicate.revision)).toBe(false)
    const stale = await build.read()
    await changeUpdateRecord(owner, record => { record.backupBusy = true })
    expect(await build.write(stale.value, stale.revision)).toBe(false)
    expect((await build.read()).value.backupBusy).toBe(true)
  } finally { database.close() }
})
