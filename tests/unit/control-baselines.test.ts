import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const installationSql = readFileSync(new URL('../../apps/instance/migrations/0000_installation_baseline.sql', import.meta.url), 'utf8')
const portalSql = readFileSync(new URL('../../apps/site/migrations/0000_portal_baseline.sql', import.meta.url), 'utf8')

describe('fresh control schemas', () => {
  it('creates Instance identity, public server IDs and refresh leases in one baseline', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(installationSql)
      db.exec("INSERT INTO auth_users (id,name,email,created_at,updated_at) VALUES ('owner','Owner','owner@example.com',0,0)")
      const insert = db.prepare("INSERT INTO servers (id,public_id,name,owner_id,origin,secret,version,status,created_at,updated_at) VALUES (?,?,?,'owner',?,'encrypted','0.1.0-alpha.1','ready',0,0)")
      insert.run('first', '00000000-0000-4000-8000-000000000001', 'First', 'https://first.example.com')
      expect(() => insert.run('second', '00000000-0000-4000-8000-000000000001', 'Second', 'https://second.example.com')).toThrow(/UNIQUE/)
      expect(() => insert.run('third', null, 'Third', 'https://third.example.com')).toThrow(/NOT NULL/)
      db.exec('INSERT INTO oauth_refresh_lock VALUES (1,123)')
      expect(() => db.exec('INSERT INTO oauth_refresh_lock VALUES (2,123)')).toThrow(/CHECK/)
      db.exec("INSERT INTO memberships VALUES ('first','owner','owner',0)")
      db.exec("DELETE FROM servers WHERE id = 'first'")
      expect(db.prepare('SELECT count(*) n FROM memberships').get()).toMatchObject({ n: 0 })
      expect(db.prepare('SELECT count(*) n FROM auth_users').get()).toMatchObject({ n: 1 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    finally { db.close() }
  })

  it('keeps portal session and routing data separate from Instance accounts', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(portalSql)
      db.exec("INSERT INTO deployment_sessions (id_hash,payload,expires_at) VALUES ('hash','encrypted',123)")
      expect(db.prepare('SELECT lease_until FROM deployment_sessions').get()).toMatchObject({ lease_until: 0 })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_users'").get()).toBeUndefined()
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    finally { db.close() }
  })
})
