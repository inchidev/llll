import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const previous = readFileSync(new URL('../fixtures/legacy-migrations/0002_auth_settings.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../fixtures/legacy-migrations/0031_google_linkedin_auth.sql', import.meta.url), 'utf8')

describe('Google and LinkedIn auth migration', () => {
  it('preserves existing encrypted credentials and owner policy while adding disabled methods', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(previous)
      db.exec("INSERT INTO auth_settings (id, github_enabled) VALUES ('main', 1)")
      const insert = db.prepare('INSERT INTO auth_provider_credentials (provider, public_key, secret_ciphertext, secret_iv) VALUES (?, ?, ?, ?)')
      for (const provider of ['github', 'twitter', 'telegram', 'turnstile']) insert.run(provider, `${provider}-id`, 'encrypted', 'iv')
      const credentials = db.prepare('SELECT * FROM auth_provider_credentials ORDER BY provider').all()
      db.exec(migration)
      expect(db.prepare('SELECT * FROM auth_provider_credentials ORDER BY provider').all()).toEqual(credentials)
      expect(db.prepare('SELECT github_enabled, google_enabled, linkedin_enabled, registration_mode FROM auth_settings').get()).toEqual({
        github_enabled: 1, google_enabled: 0, linkedin_enabled: 0, registration_mode: 'invite_only',
      })
      const updatedInsert = db.prepare('INSERT INTO auth_provider_credentials (provider, public_key, secret_ciphertext, secret_iv) VALUES (?, ?, ?, ?)')
      updatedInsert.run('google', 'google-id', 'encrypted', 'iv')
      updatedInsert.run('linkedin', 'linkedin-id', 'encrypted', 'iv')
      expect(() => updatedInsert.run('unsupported', 'id', 'encrypted', 'iv')).toThrow(/CHECK/)
      expect(db.prepare('SELECT COUNT(*) AS count FROM auth_provider_credentials').get()).toEqual({ count: 6 })
    }
    finally {
      db.close()
    }
  })
})
