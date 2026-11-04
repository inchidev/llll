// Accounts on a Server with no mail: a username and password are all anyone needs.
import assert from 'node:assert/strict'

const PLACEHOLDER = 'no-email.invalid'

export async function testAccounts({ api, ids, invite, memberId, password, db }) {
  const owner = 'alpha-owner', member = 'alpha-member'
  // Each attempt from its own address: this is about credentials, not the limit per address.
  let address = 0
  const from = () => ({ 'CF-Connecting-IP': `198.51.100.${++address}` })
  const login = (body, options = {}) => api('alpha', '/api/auth/login', { actor: 'alpha-accounts-probe', method: 'POST', body, headers: from(), ...options })

  // Nothing about a placeholder leaves the Server, on any route that describes a person.
  for (const [actor, path] of [
    [owner, '/api/me'], [member, '/api/me'],
    [owner, '/api/auth/get-session'], [member, '/api/auth/get-session'],
    [owner, `/api/servers/${ids.alpha}/members`], [member, `/api/servers/${ids.alpha}/members`],
    [member, '/api/me/email'],
  ]) {
    const { payload } = await api('alpha', path, { actor })
    assert.ok(!JSON.stringify(payload).includes(PLACEHOLDER), `${path} must not expose a placeholder address`)
  }
  assert.deepEqual(
    (({ username, email }) => ({ username, email }))((await api('alpha', '/api/me', { actor: owner })).payload.user),
    { username: 'owner', email: null },
  )
  const session = (await api('alpha', '/api/auth/get-session', { actor: member })).payload
  assert.equal(session.user.email, null)
  assert.equal(session.user.username, 'member')
  const signedIn = await login({ login: 'MEMBER', password })
  assert.equal(signedIn.payload.user.email, null)
  assert.ok(!JSON.stringify(signedIn.payload).includes(PLACEHOLDER))

  // The Member's handle starts as their username. A taken handle stays with its holder.
  const handles = async username => (await db.prepare('SELECT u.handle FROM users u JOIN auth_users a ON a.id = u.id WHERE a.username = ?').bind(username).first())?.handle
  assert.equal(await handles('owner'), 'owner')
  assert.equal(await handles('member'), 'member')

  // A wrong password and an unknown name get the same answer.
  const wrong = await login({ login: 'member', password: 'not-the-password' }, { expected: 401 })
  const unknown = await login({ login: 'nobody-here', password: 'not-the-password' }, { expected: 401 })
  assert.deepEqual(unknown.payload.error, wrong.payload.error)

  // Better Auth's own routes cannot sidestep the username and verified-email rules.
  for (const path of ['sign-in/email', 'sign-up/email', 'sign-in/username', 'sign-in/username/', 'x/../sign-in/username', 'is-username-available', 'update-user', 'send-verification-email', 'change-email', 'request-password-reset']) {
    await api('alpha', `/api/auth/${path}`, { actor: 'alpha-accounts-probe', method: 'POST', body: { email: 'member@example.com', username: 'member', password }, expected: 404 })
  }
  await api('alpha', '/api/auth/verify-email?token=x', { actor: 'alpha-accounts-probe', expected: 404 })

  // Usernames are one per Server, whatever the case.
  const code = invite
  await api('alpha', '/api/auth/signup', { actor: 'alpha-accounts-probe', method: 'POST', headers: from(), expected: 409, body: { username: 'MEMBER', password, inviteCode: code, accepted: true } })
  await api('alpha', '/api/auth/signup', { actor: 'alpha-accounts-probe', method: 'POST', headers: from(), expected: 400, body: { username: 'has space', password, inviteCode: code, accepted: true } })
  // Without an invite, this Server admits nobody.
  await api('alpha', '/api/auth/signup', { actor: 'alpha-accounts-probe', method: 'POST', headers: from(), expected: 403, body: { username: 'stranger', email: 'stranger@example.com', password, accepted: true } })

  // An added email is stored but counts for nothing: this Server cannot confirm it.
  const status = () => api('alpha', '/api/me/email', { actor: member }).then(response => response.payload)
  assert.deepEqual(await status(), { email: null, emailVerified: false, pendingEmail: null, mailReady: false, managedByAccess: false })
  const added = await api('alpha', '/api/me/email', { actor: member, method: 'POST', body: { email: 'Member@Example.com' } })
  assert.deepEqual(added.payload, { pendingEmail: 'member@example.com', confirmationSent: false })
  assert.equal((await status()).pendingEmail, 'member@example.com')
  assert.equal((await api('alpha', '/api/me', { actor: member })).payload.user.email, null)
  const unverified = await login({ login: 'member@example.com', password }, { expected: 401 })
  assert.deepEqual(unverified.payload.error, wrong.payload.error, 'An unverified address gets the same answer as an unknown one')
  // It reserves nothing: another Account can add the same address.
  await api('alpha', '/api/me/email', { actor: owner, method: 'POST', body: { email: 'member@example.com' } })
  await db.prepare("UPDATE auth_users SET pending_email = NULL WHERE username = 'owner'").run()

  // Once verified, the address signs in.
  await db.prepare("UPDATE auth_users SET email = pending_email, email_verified = 1, pending_email = NULL WHERE username = 'member'").run()
  assert.equal((await login({ login: 'Member@Example.com', password })).payload.user.email, 'member@example.com')
  assert.equal((await api('alpha', '/api/me', { actor: member })).payload.user.email, 'member@example.com')

  // A username can be changed; the old one stops working, and a taken one is refused.
  await api('alpha', '/api/me', { actor: member, method: 'PATCH', body: { username: 'owner' }, expected: 409 })
  assert.equal((await api('alpha', '/api/me', { actor: member, method: 'PATCH', body: { username: 'member-two' } })).payload.user.username, 'member-two')
  await login({ login: 'member', password }, { expected: 401 })
  assert.equal(await handles('member-two'), 'member', 'Changing a username does not move the mention handle')
  await api('alpha', '/api/me', { actor: member, method: 'PATCH', body: { username: 'member' } })

  // Forgot password: this Server has no mail, so it says so, and the login page sends people to the Owner.
  await api('alpha', '/api/auth/forgot-password', { actor: 'alpha-accounts-probe', method: 'POST', body: { login: 'member' }, expected: 503 })

  // Reset links: authority first. No Member without the permission, never the Owner, never oneself.
  const resetPath = id => `/api/servers/${ids.alpha}/members/${id}/password-reset`
  const ownerId = (await api('alpha', '/api/me', { actor: owner })).payload.user.id
  await api('alpha', resetPath(ownerId), { actor: member, method: 'POST', body: {}, expected: 403 })
  await api('alpha', resetPath(memberId), { actor: member, method: 'POST', body: {}, expected: 403 })
  await api('alpha', resetPath(memberId), { actor: 'alpha-accounts-probe-anonymous', method: 'POST', body: {}, expected: 401 })
  await api('alpha', resetPath(ownerId), { actor: owner, method: 'POST', body: {}, expected: 403 })
  await api('alpha', resetPath('00000000-0000-4000-8000-00000000dead'), { actor: owner, method: 'POST', body: {}, expected: 404 })

  // A newer link replaces an earlier one.
  const superseded = (await api('alpha', resetPath(memberId), { actor: owner, method: 'POST', body: {} })).payload
  const link = (await api('alpha', resetPath(memberId), { actor: owner, method: 'POST', body: {} })).payload
  const tokenOf = url => new URL(url).searchParams.get('token')
  assert.equal(new URL(link.url).pathname, '/reset-password')
  assert.ok(new Date(link.expiresAt).getTime() > Date.now())
  const reset = (token, newPassword) => api('alpha', '/api/auth/reset-password', { actor: 'alpha-accounts-probe', method: 'POST', body: { token, newPassword }, expected: 200 })
  const refused = (token, newPassword) => api('alpha', '/api/auth/reset-password', { actor: 'alpha-accounts-probe', method: 'POST', body: { token, newPassword }, expected: 400 })
  await refused(tokenOf(superseded.url), 'SupersededPassword123!')

  // Single use, and the Member's sessions end with the old password.
  await reset(tokenOf(link.url), 'MemberResetPassword123!')
  await refused(tokenOf(link.url), 'SecondUsePassword123!')
  await api('alpha', '/api/me', { actor: member, expected: 401 })
  await login({ login: 'member', password }, { expected: 401 })
  await login({ login: 'member', password: 'MemberResetPassword123!' })

  // An expired link is refused.
  const expired = (await api('alpha', resetPath(memberId), { actor: owner, method: 'POST', body: {} })).payload
  await db.prepare('UPDATE auth_verifications SET expires_at = 1 WHERE identifier = ?').bind(`reset-password:${tokenOf(expired.url)}`).run()
  await refused(tokenOf(expired.url), 'ExpiredLinkPassword123!')

  // Creating and using a link are both in the audit log, without the link itself.
  const audit = (await api('alpha', `/api/servers/${ids.alpha}/audit`, { actor: owner })).payload
  const actions = (audit.entries ?? audit.audit ?? audit).map(entry => entry.action)
  assert.ok(actions.includes('member.password_reset_link'))
  assert.ok(actions.includes('account.password.reset'))
  assert.ok(!JSON.stringify(audit).includes(tokenOf(link.url)))

  // Password sign-in is the login method here, and the Owner cannot switch it off and be locked out.
  const auth = (await api('alpha', `/api/servers/${ids.alpha}/auth`, { actor: owner })).payload.auth
  assert.equal(auth.methods.password, true)
  const settings = patch => ({
    registrationMode: auth.registrationMode,
    password: { enabled: true },
    email: { sender: null, senderName: null },
    providers: Object.fromEntries(Object.entries(auth.providers).map(([id, provider]) => [id, { enabled: provider.enabled, publicKey: provider.publicKey }])),
    ...patch,
  })
  const denied = await api('alpha', `/api/servers/${ids.alpha}/auth`, { actor: owner, method: 'PATCH', body: settings({ password: { enabled: false } }), expected: 400 })
  assert.equal(denied.payload.error.code, 'last_login_method')
  const github = { enabled: true, publicKey: 'client-id', secret: 'client-secret' }
  const locked = await api('alpha', `/api/servers/${ids.alpha}/auth`, { actor: owner, method: 'PATCH', body: settings({ password: { enabled: false }, providers: { ...settings().providers, github } }), expected: 400 })
  assert.equal(locked.payload.error.code, 'owner_lockout')
  await api('alpha', `/api/servers/${ids.alpha}/auth`, { actor: owner, method: 'PATCH', body: settings() })

  // Later steps sign the Member in with this password.
  const back = (await api('alpha', resetPath(memberId), { actor: owner, method: 'POST', body: {} })).payload
  await reset(tokenOf(back.url), password)
  await api('alpha', '/api/auth/login', { actor: member, method: 'POST', body: { login: 'member', password }, headers: from() })
  console.log('PASS: Accounts work with a username and no mail; placeholders stay inside; reset links are single-use, audited and bound by role')
}
