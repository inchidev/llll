import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const webSql = readFileSync(new URL('../../apps/site/migrations/0000_web_baseline.sql', import.meta.url), 'utf8')

describe('fresh control schemas', () => {
  it('keeps web session and routing data separate from Server accounts', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(webSql)
      db.exec("INSERT INTO deployment_sessions (id_hash,payload,expires_at) VALUES ('hash','encrypted',123)")
      expect(db.prepare('SELECT lease_until FROM deployment_sessions').get()).toMatchObject({ lease_until: 0 })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_users'").get()).toBeUndefined()
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    finally { db.close() }
  })
})
