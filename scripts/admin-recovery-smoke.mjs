import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** Run against an isolated Admin only: claiming replaces its test owner. */
export async function verifyAdminRecovery(origin, token) {
  const email = 'admin-preview@example.invalid'
  const password = randomBytes(24).toString('hex')
  const nextPassword = randomBytes(24).toString('hex')
  let cookie = ''
  async function request(path, { body, status = 200, authenticated = false, mutationHeader = true } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json', Origin: origin } : {}),
        ...(mutationHeader ? { 'x-llll-admin': '1' } : {}),
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    })
    assert.equal(response.status, status, `${path}: expected HTTP ${status}, got ${response.status}`)
    assert.match(response.headers.get('cache-control') || '', /no-store/u, `${path} must not cache credentials`)
    const payload = await response.json()
    const setCookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    return { payload, setCookie }
  }
  const claimed = await request('/api/claim', { body: { token, email, password } })
  cookie = claimed.setCookie
  assert.equal(claimed.payload.codes?.length, 10)
  assert.equal((await request('/api/admin/recovery', { authenticated: true })).payload.remaining, 10)
  await request('/api/admin/recovery', { body: { password: 'wrong password' }, authenticated: true, status: 401 })
  const rotated = await request('/api/admin/recovery', { body: { password }, authenticated: true })
  assert.equal(rotated.payload.codes?.length, 10)
  await request('/api/recover', { body: { email, code: claimed.payload.codes[0], password: nextPassword }, status: 401 })
  await request('/api/recover', { body: { email, code: rotated.payload.codes[0], password: nextPassword }, status: 403, mutationHeader: false })
  // Only one of two simultaneous requests may consume the code.
  const outcomes = await Promise.allSettled([
    request('/api/recover', { body: { email, code: rotated.payload.codes[0], password: nextPassword } }),
    request('/api/recover', { body: { email, code: rotated.payload.codes[0], password: nextPassword } }),
  ])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  await request('/api/admin/recovery', { authenticated: true, status: 401 })
  await request('/api/recover', { body: { email, code: rotated.payload.codes[0], password: nextPassword }, status: 401 })
  await request('/api/recover', { body: { email, code: 'invalid', password: nextPassword }, status: 401 })
  // The fifth unauthenticated attempt above exhausted the IP bucket.
  await request('/api/recover', { body: { email, code: rotated.payload.codes[1], password: nextPassword }, status: 429 })
  await request('/api/login', { body: { email, password }, status: 401 })
  const loggedIn = await request('/api/login', { body: { email, password: nextPassword } })
  cookie = loggedIn.setCookie
  assert.equal((await request('/api/admin/recovery', { authenticated: true })).payload.remaining, 9)
  // Owner selection is validated before any Cloudflare resource is provisioned.
  await request('/api/workspaces', { authenticated: true, status: 400, body: { appName: 'Owner choice check', workerName: 'owner-choice-check', forMyself: false, ownerEmail: 'invalid' } })
  await request('/api/workspaces', { authenticated: true, status: 400, body: { appName: 'Owner choice check', workerName: 'owner-choice-check', forMyself: 'false' } })
  console.log('Admin Worker verified: rejects invalid workspace owner choices before provisioning')
  console.log('Admin Worker verified: claim, rotation, recovery, concurrent consumption, session revocation, replay rejection, throttling and independent password login')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.ADMIN_SMOKE_ORIGIN || !process.env.ADMIN_SMOKE_CLAIM) throw new Error('An isolated Admin URL and its claim token are required')
  await verifyAdminRecovery(process.env.ADMIN_SMOKE_ORIGIN, process.env.ADMIN_SMOKE_CLAIM)
}
