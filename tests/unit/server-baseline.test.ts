import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'

describe('fresh L4 server schema', () => {
  it('creates the current product in one baseline and synchronizes search and task numbers', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(INIT_SQL)
      db.exec("INSERT INTO auth_users (id,name,email) VALUES ('alice','Alice','alice@example.com')")
      db.exec("INSERT INTO roles (id,key,name,permissions_bitmask) VALUES ('owner','owner','Owner',0)")
      db.exec("INSERT INTO users (id,display_name,status,role_id,joined_at) VALUES ('alice','Alice','active','owner','2026-10-16T00:00:00Z')")
      db.exec("INSERT INTO channels (id,name,type,visibility) VALUES ('chat','general','text','server')")
      db.exec("INSERT INTO messages (id,channel_id,author_id,content,created_at) VALUES ('message','chat','alice','hello isolation','2026-10-16')")
      expect(db.prepare("SELECT message_id FROM message_search WHERE message_search MATCH 'isolation'").get()).toMatchObject({ message_id: 'message' })
      db.exec("UPDATE messages SET content = 'edited search' WHERE id = 'message'")
      expect(db.prepare("SELECT count(*) n FROM message_search WHERE message_search MATCH 'isolation'").get()).toMatchObject({ n: 0 })
      db.exec("INSERT INTO task_boards (id,name,created_by) VALUES ('board','Tasks','alice')")
      db.exec("INSERT INTO tasks (id,board_id,title,created_by) VALUES ('task','board','First task','alice')")
      expect(db.prepare('SELECT number FROM task_numbers WHERE task_id = ?').get('task')).toMatchObject({ number: 1001 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'task_runs'").get()).toBeUndefined()
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'scheduled_lives'").get()).toBeUndefined()
      expect(() => db.exec("INSERT INTO channels (id,name,type,visibility) VALUES ('retired','Old voice','voice','server')")).toThrow()
      db.exec("INSERT INTO tasks (id,board_id,title,created_by) VALUES ('second','board','Second task','alice')")
      db.exec("DELETE FROM tasks WHERE id = 'task'")
      db.exec("INSERT INTO tasks (id,board_id,title,created_by) VALUES ('third','board','Third task','alice')")
      expect(db.prepare('SELECT number FROM task_numbers WHERE task_id = ?').get('third')).toMatchObject({ number: 1003 })
    }
    finally { db.close() }
  })

  it('starts social methods disabled and constrains configured providers', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(INIT_SQL)
      db.exec("INSERT INTO auth_settings (id) VALUES (1)")
      expect(db.prepare('SELECT google_enabled, linkedin_enabled, registration_mode FROM auth_settings').get()).toMatchObject({ google_enabled: 0, linkedin_enabled: 0, registration_mode: 'invite_only' })
      const insert = db.prepare('INSERT INTO auth_provider_credentials (provider, public_key, secret_ciphertext, secret_iv) VALUES (?, ?, ?, ?)')
      insert.run('google', 'id', 'encrypted', 'iv')
      insert.run('linkedin', 'id', 'encrypted', 'iv')
      expect(() => insert.run('unsupported', 'id', 'encrypted', 'iv')).toThrow(/CHECK/)
    }
    finally { db.close() }
  })
})
