import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function parseConfig(path: string) {
  const source = await readFile(resolve(import.meta.dirname, path), 'utf8')
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''))
}

describe('Worker Preview configuration', () => {
  it('declares every Durable Object binding under previews or the Preview fails with error 1101', async () => {
    const config = await parseConfig('../../wrangler.jsonc')
    expect(config.name).toBe('llll-server')
    const envBindings = config.durable_objects.bindings
    const previewBindings = config.previews.durable_objects.bindings
    expect(previewBindings).toEqual(envBindings)
  })

  it('does not inherit production vars and binds the shared staging resources', async () => {
    const config = await parseConfig('../../wrangler.jsonc')
    const previews = config.previews
    expect(Object.keys(previews.vars)).toEqual(
      expect.arrayContaining(['PUBLIC_ORIGIN', 'ADMIN_EMAIL', 'AUTH_REGISTRATION_MODE']),
    )
    expect(previews.vars.PUBLIC_ORIGIN).not.toBe(config.vars.PUBLIC_ORIGIN)
    const db = previews.d1_databases.find((item: { binding: string }) => item.binding === 'DB')
    expect(db?.migrations_dir).toBe(config.d1_databases[0]!.migrations_dir)
    const files = previews.r2_buckets.find((item: { binding: string }) => item.binding === 'FILES')
    const backups = previews.r2_buckets.find((item: { binding: string }) => item.binding === 'BACKUPS')
    expect(files?.bucket_name).toBeTruthy()
    expect(backups?.bucket_name).toBeTruthy()
    expect(backups?.bucket_name).not.toBe(files?.bucket_name)
    expect(previews.kv_namespaces.find((item: { binding: string }) => item.binding === 'TICKETS')?.id).toBeTruthy()
  })

  it('keeps the official site Worker ready for Previews with its own D1', async () => {
    const config = await parseConfig('../../apps/site/wrangler.jsonc')
    expect(config.name).toBe('llll')
    expect(config.previews).toEqual({})
    expect(config.workers_dev).toBe(false)
  })

  it('applies 0010 Server settings during a fresh local migration run', async () => {
    const { INIT_SQL } = await import('../../server/utils/db')
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    const columns = sqlite.prepare('PRAGMA table_info(server_setup)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(
      expect.arrayContaining(['singleton', 'email', 'token_hash', 'server_name']),
    )
    sqlite.exec("INSERT INTO server_settings(key,value,updated_at) VALUES ('worker_name','llll-test','2026-10-22T00:00:00.000Z')")
    expect(sqlite.prepare('SELECT value FROM server_settings WHERE key = ?').get('worker_name') as SQLInputValue).toBeTruthy()
    sqlite.close()
  })
})
