// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { createAuth } from '../../server/utils/better-auth'
import type { AuthRuntimeConfig } from '../../server/utils/auth-config'
import type { L4Env } from '../../workers/env'

const origin = 'https://chat.example.com'
const config: AuthRuntimeConfig = {
  mode: 'builtin', registrationMode: 'open',
  enabled: { password: true, github: false, google: false, linkedin: false, twitter: false, turnstile: false },
  credentials: {}, email: { binding: false, from: null, fromName: null, senderManagedByDeployment: false, verificationReady: false },
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...next: SQLInputValue[]) { values = next; return statement },
        async first() { return database.prepare(sql).get(...values) ?? null },
        async all() { return { results: database.prepare(sql).all(...values), success: true, meta: {} } },
        async raw() { const query = database.prepare(sql); query.setReturnArrays(true); return query.all(...values) },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) } },
      }
      return statement
    },
  } as unknown as D1Database
}

it('gives an Account made by a provider a generated username, and a free one when the name is taken', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  const env = { DB: d1(sqlite), PUBLIC_ORIGIN: origin, AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters' } as L4Env
  const { internalAdapter } = await (await createAuth(env, origin, undefined, config)).$context
  const made = async (name: string, email: string, accountId: string) =>
    (await internalAdapter.createOAuthUser({ name, email, emailVerified: true }, { providerId: 'github', accountId })).user as { username: string; email: string }

  const first = await made('Ada Lovelace', 'ada@example.com', '1')
  expect(first.username).toBe('ada-lovelace')
  // Nothing is linked by email or name: a second person with that name is a second Account.
  const second = await made('Ada Lovelace', 'other@example.com', '2')
  expect(second.username).toMatch(/^ada-lovelace-[0-9a-f]{6}$/u)
  sqlite.close()
})
