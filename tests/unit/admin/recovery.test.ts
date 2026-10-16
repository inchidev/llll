import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../../../apps/admin/server/utils/db'
import { generateRecoveryCodes, limitRecovery, recoverPassword, recoveryCodeCount, rotateRecoveryCodes } from '../../../apps/admin/server/utils/recovery'
import { hashPassword, verifyPassword } from '../../../apps/admin/server/utils/secrets'

/** Real SQL and transactions, including rollback on a failed batch statement. */
function database(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    sql, values,
    bind: (...next: SQLInputValue[]) => prepare(sql, next),
    async first() { return sqlite.prepare(sql).get(...values) ?? null },
    async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) } },
  })
  return {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push({ meta: sqlite.prepare(statement.sql).run(...statement.values) })
        sqlite.exec('COMMIT')
        return results
      }
      catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

describe('local Admin recovery', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let codes: string[]
  const email = 'owner@example.com'
  const password = 'old owner password'
  const newPassword = 'new owner password'

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    db = database(sqlite)
    await ensureSchema(db)
    sqlite.prepare('INSERT INTO owners VALUES (?, ?, ?, ?, ?)').run('owner', email, await hashPassword(password), 'now', 'now')
    sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('old-session', 'owner', 'later', 'now')
    codes = await generateRecoveryCodes(db, 'owner')
  })
  afterEach(() => { sqlite.close(); vi.useRealTimers() })

  it('stores only hashes and returns ten distinct 128-bit codes once', async () => {
    expect(new Set(codes).size).toBe(10)
    expect(codes.every(code => /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/u.test(code))).toBe(true)
    expect(await recoveryCodeCount(db, 'owner')).toBe(10)
    const stored = JSON.stringify(sqlite.prepare('SELECT * FROM recovery_codes').all())
    for (const code of codes) expect(stored).not.toContain(code.replaceAll('-', ''))
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM audit').all())).not.toContain(codes[0])
  })

  it('changes the password, consumes one code and revokes every old session', async () => {
    await recoverPassword(db, { email: ' OWNER@EXAMPLE.COM ', code: codes[0]!.toUpperCase(), password: newPassword })
    const owner = sqlite.prepare('SELECT password_hash AS hash FROM owners').get() as { hash: string }
    expect(await verifyPassword(password, owner.hash)).toBe(false)
    expect(await verifyPassword(newPassword, owner.hash)).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
    expect(await recoveryCodeCount(db, 'owner')).toBe(9)
    await expect(recoverPassword(db, { email, code: codes[0], password })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects wrong identity, malformed and incorrect codes without changing credentials', async () => {
    for (const input of [{ email: 'unknown@example.com', code: codes[0] }, { email, code: 'wrong' }, { email, code: 'a'.repeat(32) }]) {
      await expect(recoverPassword(db, { ...input, password: newPassword })).rejects.toMatchObject({ statusCode: 401 })
    }
    expect(await recoveryCodeCount(db, 'owner')).toBe(10)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 })
  })

  it('does not consume a code for a password rejected by policy', async () => {
    await expect(recoverPassword(db, { email, code: codes[0], password: 'short' })).rejects.toMatchObject({ statusCode: 400 })
    expect(await recoveryCodeCount(db, 'owner')).toBe(10)
  })

  it('requires the current password to replace the entire code set', async () => {
    await expect(rotateRecoveryCodes(db, 'owner', 'wrong')).rejects.toMatchObject({ statusCode: 401 })
    const rotated = await rotateRecoveryCodes(db, 'owner', password)
    expect(rotated).toHaveLength(10)
    expect(await recoveryCodeCount(db, 'owner')).toBe(10)
    await expect(recoverPassword(db, { email, code: codes[0], password: newPassword })).rejects.toMatchObject({ statusCode: 401 })
    await expect(recoverPassword(db, { email, code: rotated[0], password: newPassword })).resolves.toEqual({ recovered: true })
  })

  it('cannot issue codes using a password verification made before a concurrent reset', async () => {
    const owner = sqlite.prepare('SELECT password_hash AS hash FROM owners').get() as { hash: string }
    await recoverPassword(db, { email, code: codes[0], password: newPassword })
    await expect(generateRecoveryCodes(db, 'owner', owner.hash)).rejects.toMatchObject({ statusCode: 401 })
    expect(await recoveryCodeCount(db, 'owner')).toBe(9)
  })

  it('rolls back consumption and password change if session revocation fails', async () => {
    sqlite.exec("CREATE TRIGGER prevent_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    await expect(recoverPassword(db, { email, code: codes[0], password: newPassword })).rejects.toThrow('test failure')
    expect(await recoveryCodeCount(db, 'owner')).toBe(10)
    const owner = sqlite.prepare('SELECT password_hash AS hash FROM owners').get() as { hash: string }
    expect(await verifyPassword(password, owner.hash)).toBe(true)
  })

  it('allows exactly one concurrent recovery with the same code', async () => {
    const outcomes = await Promise.allSettled([
      recoverPassword(db, { email, code: codes[0], password: newPassword }),
      recoverPassword(db, { email, code: codes[0], password: 'competing password' }),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    expect(await recoveryCodeCount(db, 'owner')).toBe(9)
  })

  it('limits recovery attempts persistently and releases the bucket after 15 minutes', async () => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 5; attempt++) await limitRecovery(db, '192.0.2.1')
    await expect(limitRecovery(db, '192.0.2.1')).rejects.toMatchObject({ statusCode: 429 })
    await expect(limitRecovery(db, '192.0.2.2')).resolves.toBeUndefined()
    vi.advanceTimersByTime(15 * 60 * 1000)
    await expect(limitRecovery(db, '192.0.2.1')).resolves.toBeUndefined()
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM recovery_attempts').all())).not.toContain('192.0.2.1')
  })
})
