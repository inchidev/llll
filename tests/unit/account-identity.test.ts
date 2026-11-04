// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { isUsername, loginSchema, normalizeUsername, optionalEmailSchema, usernameFrom, usernameSchema } from '../../shared/account'
import { accountEmail, findAccountByLogin, findAccountByVerifiedEmail, hidePlaceholderEmails, isPlaceholderEmail, isUsernameConflict, placeholderEmail, placeholderId, verifiedEmail } from '../../server/utils/account-identity'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL, getDb } from '../../server/utils/db'

describe('usernames', () => {
  it('keeps what was typed, normalizes separately, and limits the characters and length', () => {
    expect(usernameSchema.parse(' Ada.Lovelace ')).toBe('Ada.Lovelace')
    expect(normalizeUsername('Ada.Lovelace')).toBe('ada.lovelace')
    for (const bad of ['ab', 'a'.repeat(33), '.ada', 'ada-', 'ada lovelace', 'ada@example.com', 'адa']) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('makes a valid candidate from a name or address part', () => {
    expect(usernameFrom('Ada Lovelace')).toBe('ada-lovelace')
    expect(usernameFrom('jo')).toBe('member-jo')
    expect(usernameFrom('')).toBe('member')
    expect(usernameFrom('...')).toBe('member')
    expect(isUsername(usernameFrom('x'.repeat(200)))).toBe(true)
  })

  it('never lets a login value that is an address be a username', () => {
    expect(isUsername(loginSchema.parse(' Ada@Example.COM '))).toBe(false)
  })

  it('treats a blank optional email as none', () => {
    expect(optionalEmailSchema.parse('')).toBeUndefined()
    expect(optionalEmailSchema.parse(undefined)).toBeUndefined()
    expect(optionalEmailSchema.parse(' Ada@Example.com ')).toBe('ada@example.com')
    expect(optionalEmailSchema.safeParse('not-an-email').success).toBe(false)
  })
})

describe('the placeholder address', () => {
  it('is hidden from display and never counts as verified', () => {
    const email = placeholderEmail('account-1')
    expect(isPlaceholderEmail(email)).toBe(true)
    expect(placeholderId(email)).toBe('account-1')
    expect(placeholderId('ada@example.com')).toBeNull()
    expect(accountEmail({ email })).toBeNull()
    expect(verifiedEmail({ email, emailVerified: true })).toBeNull()
    expect(accountEmail({ email: 'ada@example.com' })).toBe('ada@example.com')
    expect(verifiedEmail({ email: 'ada@example.com', emailVerified: false })).toBeNull()
    expect(verifiedEmail({ email: 'ada@example.com', emailVerified: true })).toBe('ada@example.com')
  })

  it('is removed from Better Auth responses, keeping status and cookies', async () => {
    const email = placeholderEmail('account-1')
    const headers = new Headers({ 'content-type': 'application/json', 'content-length': '999' })
    headers.append('set-cookie', 'a=1')
    headers.append('set-cookie', 'b=2')
    const response = await hidePlaceholderEmails(new Response(JSON.stringify({ session: { id: 's' }, user: { id: 'account-1', email, name: 'Ada' } }), { status: 201, headers }))
    expect(response.status).toBe(201)
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.json()).toEqual({ session: { id: 's' }, user: { id: 'account-1', email: null, name: 'Ada' } })
  })

  it('leaves other responses as they are', async () => {
    const real = new Response(JSON.stringify({ user: { email: 'ada@example.com' } }), { headers: { 'content-type': 'application/json' } })
    expect(await hidePlaceholderEmails(real)).toBe(real)
    const redirect = new Response(null, { status: 302, headers: { location: '/' } })
    expect(await hidePlaceholderEmails(redirect)).toBe(redirect)
  })
})

describe('finding the Account a login names', () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO auth_users (id, name, email, email_verified, username, pending_email) VALUES
      ('none', 'None', '${placeholderEmail('none')}', 0, 'no-mail', NULL),
      ('pending', 'Pending', '${placeholderEmail('pending')}', 0, 'pending', 'claimed@example.com'),
      ('social', 'Social', 'unverified@example.com', 0, 'social', NULL),
      ('verified', 'Ada', 'ada@example.com', 1, 'ada', NULL);`)
  const db = getDb(d1(sqlite))

  it('finds by username, in any case', async () => {
    expect((await findAccountByLogin(db, ' NO-Mail '))?.id).toBe('none')
  })
  it('finds by a verified email', async () => {
    expect((await findAccountByLogin(db, 'ADA@example.com'))?.id).toBe('verified')
  })
  it('refuses an unverified email, a pending email and a placeholder', async () => {
    expect(await findAccountByLogin(db, 'unverified@example.com')).toBeNull()
    expect(await findAccountByLogin(db, 'claimed@example.com')).toBeNull()
    expect(await findAccountByLogin(db, placeholderEmail('none'))).toBeNull()
    expect(await findAccountByLogin(db, 'nobody')).toBeNull()
  })
  it('never reads a username as an address', async () => {
    expect(await findAccountByVerifiedEmail(db, 'ada')).toBeNull()
    expect((await findAccountByVerifiedEmail(db, 'Ada@example.com'))?.username).toBe('ada')
  })
})

describe('username conflicts', () => {
  it('recognizes the unique failure through wrappers, and nothing else', () => {
    const cause = new Error('D1_ERROR: UNIQUE constraint failed: auth_users.username: SQLITE_CONSTRAINT')
    expect(isUsernameConflict(cause)).toBe(true)
    expect(isUsernameConflict(new Error('Failed query', { cause }))).toBe(true)
    expect(isUsernameConflict(new Error('UNIQUE constraint failed: auth_users.email'))).toBe(false)
  })
  it('recognizes the username plugin refusing a name', () => {
    expect(isUsernameConflict({ body: { code: 'USERNAME_IS_ALREADY_TAKEN' } })).toBe(true)
    expect(isUsernameConflict({ body: { code: 'INVALID_USERNAME' } })).toBe(false)
  })
})
