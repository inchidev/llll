// Open sign-up, against the real Worker with siteverify and a mail gateway stubbed at the network:
// without mail and Turnstile nobody gets in, and signing up without passing Turnstile creates nothing.
// With mail, an address is confirmed by its link before it signs in or resets a password.
// Build first: pnpm build:deployment
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare'

const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.LLLL_TEST_PORT || 19284)
const origin = `http://127.0.0.1:${port}`
const password = 'LocalServerIntegrationPassword123!'
const setup = 'local-owner-claim-'.repeat(4)
const classes = { CHANNEL_DO: 'ChannelDurableObject', SERVER_DO: 'ServerDurableObject', RATE_LIMIT_DO: 'RateLimitDurableObject', NOTIFICATION_DO: 'NotificationDurableObject', AGENT_DO: 'L4Agent' }

let siteverify = 0
const mail = []
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, log: new Log(LogLevel.WARN),
  workers: [{
    name: 'signup-turnstile', modules: true, scriptPath: resolve(root, '.installer/bundle/index.js'),
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    d1Databases: { DB: 'signup' }, r2Buckets: { FILES: 'signup-files' }, kvNamespaces: { TICKETS: 'signup-tickets' },
    durableObjects: Object.fromEntries(Object.entries(classes).map(([binding, className]) => [binding, { className, useSQLite: true }])),
    serviceBindings: { ASSETS: async () => new Response('Not found', { status: 404 }) },
    outboundService: async (request) => {
      if (new URL(request.url).hostname === 'mail.test') {
        mail.push(await request.json())
        return Response.json({ messageId: `m${mail.length}` })
      }
      if (new URL(request.url).hostname !== 'challenges.cloudflare.com') return new Response('Blocked by the test', { status: 599 })
      siteverify++
      const form = new URLSearchParams(await request.text())
      assert.equal(form.get('secret'), 'turnstile-secret')
      if (form.get('response') === 'other-host') return Response.json({ success: true, action: 'signup', hostname: 'evil.example' })
      return Response.json(form.get('response') === 'good-token' ? { success: true, action: 'signup', hostname: '127.0.0.1' } : { success: false })
    },
    bindings: { PUBLIC_ORIGIN: origin, LLLL_RUNTIME: 'cloudflare', AUTH_SECRET: 'signup-server-secret-'.repeat(4), SETUP_TOKEN: setup,
      AUTH_REGISTRATION_MODE: 'open', MAIL_GATEWAY_URL: 'https://mail.test/send', MAIL_GATEWAY_TOKEN: 'gateway-token', TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'turnstile-secret' },
  }],
}))

try {
  const db = await runtime.getD1Database('DB')
  for (const file of (await readdir(resolve(root, 'drizzle/server-migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await readFile(resolve(root, 'drizzle/server-migrations', file), 'utf8')).split('--> statement-breakpoint').map(part => part.split('\n').filter(line => !line.trimStart().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'))
  }
  let address = 0
  const post = (path, body, headers = {}) => runtime.dispatchFetch(origin + path, {
    method: 'POST',
    // Each attempt from its own address: this test is about the check, not the limit per address.
    headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++address}`, ...headers },
    body: JSON.stringify(body),
  })
  const signup = (email, headers) => post('/api/auth/signup', { username: email.split('@')[0], email, password, accepted: true }, headers)
  const account = username => db.prepare('SELECT email, email_verified AS verified, pending_email AS pending FROM auth_users WHERE username = ?').bind(username).first()
  const owner = await post('/api/setup/owner', { token: setup, username: 'owner', name: 'Owner', password })
  assert.equal(owner.status, 200)
  const config = async () => (await runtime.dispatchFetch(`${origin}/api/auth/config`, { headers: { Host: `127.0.0.1:${port}` } })).json()

  // Open registration without mail or Turnstile: the config says so, and the route agrees.
  assert.deepEqual((({ signupEnabled, emailSignupEnabled, inviteSignupEnabled, passwordResetEnabled }) => ({ signupEnabled, emailSignupEnabled, inviteSignupEnabled, passwordResetEnabled }))(await config()),
    { signupEnabled: false, emailSignupEnabled: false, inviteSignupEnabled: true, passwordResetEnabled: false })
  const closed = await signup('off@example.com')
  assert.equal(closed.status, 403)
  assert.equal((await closed.json()).error.code, 'signup_disabled')
  assert.equal(await account('off'), null)

  // Mail is connected, but with no sender and no Turnstile that is still not enough.
  await db.prepare("UPDATE auth_settings SET turnstile_enabled = 1, email_from = 'login@example.test' WHERE id = 1").run()
  for (const [name, headers, calls] of [['no-token', {}, 0], ['bad-token', { 'x-captcha-response': 'bad-token' }, 1], ['other-host', { 'x-captcha-response': 'other-host' }, 1]]) {
    const before = siteverify, email = `${name}@example.com`
    const response = await signup(email, headers)
    assert.equal(response.status, 403, name)
    assert.equal((await response.json()).error.code, 'captcha_failed', name)
    assert.equal(siteverify - before, calls, `${name}: siteverify calls`)
    assert.equal(await account(email), null, `${name}: no Account`)
    assert.equal(await db.prepare("SELECT id FROM users WHERE display_name = ?").bind(name).first(), null, `${name}: no Member`)
  }

  const missingEmail = await post('/api/auth/signup', { username: 'no-address', password, accepted: true }, { 'x-captcha-response': 'good-token' })
  assert.equal(missingEmail.status, 400, 'Without an invite, sign-up needs an address')
  assert.equal(await account('no-address'), null)

  const before = siteverify
  const joined = await signup('good-token@example.com', { 'x-captcha-response': 'good-token' })
  assert.equal(joined.status, 200)
  assert.equal(siteverify - before, 1)
  const joinedBody = await joined.json()
  assert.equal(joinedBody.user.email, null)
  assert.equal(joinedBody.emailConfirmationSent, true)
  const pending = await account('good-token')
  assert.equal(pending.verified, 0, 'Passing Turnstile proves a person, not an address')
  assert.equal(pending.pending, 'good-token@example.com')

  // Signing in does not wait for the address, and the address does not sign in until it is confirmed.
  assert.equal((await post('/api/auth/login', { login: 'good-token', password })).status, 200)
  assert.equal((await post('/api/auth/login', { login: 'good-token@example.com', password })).status, 401)

  // A reset request for an unconfirmed address sends nothing, and says nothing about it.
  const until = async (found) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const message = mail.find(found)
      if (message) return message
      await new Promise(done => setTimeout(done, 100))
    }
    assert.fail('Expected mail did not arrive')
  }
  const verifyMail = await until(message => message.subject.startsWith('Verify'))
  assert.equal(verifyMail.to, 'good-token@example.com')
  const sent = mail.length
  assert.equal((await post('/api/auth/forgot-password', { login: 'good-token' })).status, 200)
  await new Promise(done => setTimeout(done, 300))
  assert.equal(mail.length, sent, 'No reset mail without a verified address')

  // The link confirms the address once, and does not sign anyone in.
  const link = verifyMail.text.match(/Verify email: (\S+)/)[1]
  const opened = await runtime.dispatchFetch(link, { redirect: 'manual', headers: { Host: `127.0.0.1:${port}` } })
  assert.equal(opened.status, 302)
  assert.match(opened.headers.get('location'), /verified=1/)
  assert.ok(!opened.headers.getSetCookie().some(cookie => cookie.includes('session_token')))
  const again = await runtime.dispatchFetch(link, { redirect: 'manual', headers: { Host: `127.0.0.1:${port}` } })
  assert.match(again.headers.get('location'), /verify_error=invalid/)
  const confirmed = await account('good-token')
  assert.deepEqual(confirmed, { email: 'good-token@example.com', verified: 1, pending: null })
  const byEmail = await post('/api/auth/login', { login: 'good-token@example.com', password })
  assert.equal(byEmail.status, 200)
  assert.equal((await byEmail.json()).user.email, 'good-token@example.com')

  // With a verified address and mail, the ordinary reset flow runs, by username or email.
  assert.equal((await post('/api/auth/forgot-password', { login: 'good-token' })).status, 200)
  const resetMail = await until(message => message.subject.startsWith('Reset'))
  assert.equal(resetMail.to, 'good-token@example.com')

  // Two Accounts can hold one address as pending. The first to confirm keeps it; the second link says so.
  const cookies = {}
  const signIn = async (who) => {
    const response = await post('/api/auth/login', { login: who, password })
    assert.equal(response.status, 200)
    cookies[who] = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  }
  const invite = await (async () => {
    await signIn('owner')
    const health = await post('/api/auth/ws-token', {}, { Cookie: cookies.owner })
    assert.equal(health.status, 200)
    const server = await (await runtime.dispatchFetch(`${origin}/api/server`, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookies.owner } })).json()
    return (await (await post(`/api/servers/${server.server.id}/invites`, { maxUses: 1 }, { Cookie: cookies.owner })).json()).invite.code
  })()
  // An invite needs no address and no mail, even here.
  assert.equal((await post('/api/auth/signup', { username: 'invited', password, inviteCode: invite, accepted: true }, { 'x-captcha-response': 'good-token' })).status, 200)
  await signIn('invited')
  mail.length = 0
  await post('/api/me/email', { email: 'contested@example.com' }, { Cookie: cookies.owner })
  const ownerLink = (await until(message => message.to === 'contested@example.com')).text.match(/Verify email: (\S+)/)[1]
  mail.length = 0
  await post('/api/me/email', { email: 'contested@example.com' }, { Cookie: cookies.invited })
  const invitedLink = (await until(message => message.to === 'contested@example.com')).text.match(/Verify email: (\S+)/)[1]
  const first = await runtime.dispatchFetch(ownerLink, { redirect: 'manual', headers: { Host: `127.0.0.1:${port}` } })
  assert.match(first.headers.get('location'), /verified=1/)
  const second = await runtime.dispatchFetch(invitedLink, { redirect: 'manual', headers: { Host: `127.0.0.1:${port}` } })
  assert.match(second.headers.get('location'), /verify_error=taken/)
  assert.equal((await account('owner')).email, 'contested@example.com')
  assert.notEqual((await account('invited')).email, 'contested@example.com')
  console.log('PASS: Open sign-up needs mail and Turnstile, Turnstile refuses a missing, bad or foreign token before any Account exists, an invite needs neither, and an address counts only once its link is opened')
}
finally {
  await runtime.dispose()
}
