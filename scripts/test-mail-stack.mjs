// Uses the compiled dev stack in a disposable Docker project. All outbound
// mail ends at a local capture server; this never sends to the internet.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, '.deployment/dev-stack')
const config = parseEnv(await readFile(resolve(directory, '.env'), 'utf8'))
const inspected = spawnSync('docker', ['context', 'inspect', config.LLLL_DOCKER_CONTEXT], { encoding: 'utf8' })
assert.equal(inspected.status, 0, 'The saved Docker context must exist')
assert.ok(JSON.parse(inspected.stdout)[0].Endpoints.docker.Host.startsWith('unix://'), 'Only local Docker is supported')
const captured = []
const gatewayToken = randomBytes(32).toString('hex')
const gateway = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${gatewayToken}`) { response.writeHead(403).end(); return }
  const chunks = []
  for await (const part of request) chunks.push(part)
  captured.push(JSON.parse(Buffer.concat(chunks).toString()))
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ messageId: `<local-${captured.length}@example.test>` }))
})
await new Promise(resolve => gateway.listen(0, '0.0.0.0', resolve))
const gatewayPort = gateway.address().port
const portFinder = createServer()
await new Promise(resolve => portFinder.listen(0, '127.0.0.1', resolve))
const port = portFinder.address().port
await new Promise(resolve => portFinder.close(resolve))
const origin = `http://localhost:${port}`
const runId = randomBytes(6).toString('hex')
const project = `${config.LLLL_PROJECT}-mail-${runId}`
const secret = randomBytes(32).toString('hex')
const fixture = {
  ...config, LLLL_PROJECT: project, LLLL_HTTP_PORT: String(port), PUBLIC_ORIGIN: origin,
  AUTH_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: randomBytes(32).toString('hex'),
  RUSTFS_ACCESS_KEY: randomBytes(16).toString('hex'), RUSTFS_SECRET_KEY: randomBytes(32).toString('hex'),
  LLLL_EMAIL_DOMAINS: JSON.stringify([{ id: 'local-mail', zoneId: '', domain: 'example.test' }]),
  MAIL_APP_HOSTNAME: 'chat.example.test', MAIL_DEFAULT_LOCAL_PART: 'support',
  INBOUND_EMAIL_SECRET: secret, MAIL_GATEWAY_URL: `http://host.docker.internal:${gatewayPort}/send`, MAIL_GATEWAY_TOKEN: gatewayToken,
}
const envFile = resolve(directory, `${project}.env`)
const override = resolve(directory, `${project}.yml`)
await writeFile(envFile, Object.entries(fixture).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600, flag: 'wx' })
await writeFile(override, `services:\n  llll:\n    image: ${config.LLLL_PROJECT}-dev:celld-0.6.2\n    extra_hosts:\n      - host.docker.internal:host-gateway\n`, { mode: 0o600, flag: 'wx' })
const compose = ['--context', config.LLLL_DOCKER_CONTEXT, 'compose', '--project-name', project, '--env-file', envFile,
  '-f', resolve(root, 'self-host/docker-compose.yml'), '-f', resolve(root, 'self-host/compose.dev.yml'), '-f', override]
const env = { ...process.env, ...fixture, LLLL_ENV_FILE: envFile }
function docker(args) {
  const result = spawnSync('docker', [...compose, ...args], { cwd: root, env, stdio: 'pipe', encoding: 'utf8', timeout: 300000 })
  assert.equal(result.status, 0, `Compose ${args[0]} failed: ${result.stderr}`)
}
const cookies = {}
async function api(path, { actor = 'owner', method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(origin + path, {
    method, signal: AbortSignal.timeout(30000),
    headers: { Origin: origin, Cookie: cookies[actor] || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  for (const cookie of response.headers.getSetCookie()) if (cookie.includes('session_token=')) cookies[actor] = cookie.split(';')[0]
  assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`)
  return response
}
async function inbound(id, inReplyTo, attachment = false) {
  const from = 'customer@example.net', to = 'support@example.test'
  const lines = ['From: Customer <customer@example.net>', 'Reply-To: replies@example.net', `To: ${to}, colleague@example.net`, 'Cc: copy@example.net', 'Subject: Local mail acceptance', `Message-ID: <${id}@example.net>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}@example.net>`] : []), 'MIME-Version: 1.0']
  if (attachment) lines.push('Content-Type: multipart/mixed; boundary="fixture"', '', '--fixture', 'Content-Type: text/plain', '', 'Hello', '--fixture', 'Content-Type: text/html', 'Content-Disposition: attachment; filename="attack.html"', '', '<script>window.localMailAttack=true</script>', '--fixture--')
  else lines.push('Content-Type: text/plain', '', 'Local acceptance email')
  const raw = lines.join('\r\n')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', secret).update(`${timestamp}.${from}.${to}.${raw}`).digest('hex')
  const response = await fetch(origin + '/api/email/inbound', { method: 'POST', signal: AbortSignal.timeout(30000), headers: {
    'Content-Type': 'message/rfc822', 'x-llll-email-timestamp': timestamp, 'x-llll-email-from': from,
    'x-llll-email-to': to, 'x-llll-email-signature': signature,
  }, body: raw })
  assert.equal(response.status, 202, `Inbound: ${await response.text()}`)
}
try {
  docker(['up', '-d', '--no-build', '--wait', '--wait-timeout', '240'])
  const discovery = await (await api('/.well-known/llll')).json()
  const developer = await (await fetch(config.PUBLIC_ORIGIN + '/.well-known/llll')).json()
  assert.notEqual(discovery.id, developer.id)
  const password = randomBytes(24).toString('hex')
  await api('/api/setup/owner', { method: 'POST', body: { token: fixture.SETUP_TOKEN, name: 'Mail acceptance owner', password } })
  const { mailboxes } = await (await api('/api/mail/mailboxes')).json()
  const mailbox = mailboxes.find(item => item.address === 'support@example.test')
  assert.ok(mailbox, 'Owner has a configured local mailbox')
  const settings = await (await api(`/api/servers/${discovery.id}/mail`)).json()
  assert.equal(settings.mail.domains[0].domain, 'example.test')
  const health = await (await api('/api/setup/health')).json()
  assert.equal(health.capabilities.emailProvider, 'gateway')
  const invite = await (await api(`/api/servers/${discovery.id}/invites`, { method: 'POST', body: { maxUses: 1 } })).json()
  const signup = await (await api('/api/auth/signup', { actor: 'member', method: 'POST', body: { name: 'No mail access', email: 'member@example.test', password, inviteCode: invite.invite.code, accepted: true } })).json()
  if (signup.verificationRequired) {
    let verification
    for (let attempt = 0; attempt < 50; attempt++) {
      verification = captured.find(message => message.subject.startsWith('Verify your'))
      if (verification) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(verification, 'Verification email must reach the local capture gateway')
    const link = new URL(verification.text.match(/Verify email: (\S+)/)[1])
    assert.equal(link.origin, origin)
    const verified = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
    assert.ok(verified.status === 200 || verified.status === 302)
    await api('/api/auth/login', { actor: 'member', method: 'POST', body: { email: 'member@example.test', password } })
  }
  captured.length = 0
  await api(`/api/invites/${invite.invite.code}/accept`, { actor: 'member', method: 'POST', body: {} })
  assert.deepEqual((await (await api('/api/mail/mailboxes', { actor: 'member' })).json()).mailboxes, [])
  await inbound('first', null, true)
  const inbox = await (await api(`/api/mail/mailboxes/${mailbox.channelId}/threads`)).json()
  assert.equal(inbox.threads.length, 1)
  const thread = inbox.threads[0].channelId
  const detailPath = `/api/mail/threads/${thread}`
  const detail = await (await api(detailPath)).json()
  const attachment = detail.messages.flatMap(item => item.attachments)[0]
  assert.ok(attachment)
  const file = await api(`/api/files/${attachment.id}`)
  assert.equal(file.headers.get('content-type'), 'application/octet-stream')
  assert.match(file.headers.get('content-disposition'), /^attachment;/)
  assert.match(file.headers.get('content-security-policy'), /sandbox/)
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
  await api(detailPath, { actor: 'member', expected: 404 })
  await api(`/api/files/${attachment.id}`, { actor: 'member', expected: 404 })
  console.log('PASS: isolated Server, configured mailbox, denied member access and safe inbound attachment headers')

  await api(`${detailPath}/reply`, { method: 'POST', body: { content: 'Private reply', clientId: randomBytes(12).toString('hex') } })
  assert.deepEqual(captured.at(-1).to, ['replies@example.net'])
  assert.equal(captured.at(-1).headers['In-Reply-To'], '<first@example.net>')
  await api(`${detailPath}/reply`, { method: 'POST', body: { content: 'Reply all', replyAll: true, clientId: randomBytes(12).toString('hex') } })
  assert.deepEqual(captured.at(-1).to, ['replies@example.net', 'colleague@example.net', 'copy@example.net'])
  for (const status of ['spam', 'trash']) {
    await api(detailPath, { method: 'PATCH', body: { status } })
    await inbound(`followup-${status}`, 'first')
    assert.equal((await (await api(detailPath)).json()).thread.status, status)
  }
  const send = body => api(`/api/mail/mailboxes/${mailbox.channelId}/send`, { method: 'POST', body })
  const body = { to: ['recipient@example.net'], subject: 'Hello\r\nBcc: forged@example.net', content: 'Local only', clientId: randomBytes(12).toString('hex') }
  const first = await (await send(body)).json()
  assert.equal(first.message.email.deliveryStatus, 'sent')
  assert.equal(first.thread.subject, 'Hello Bcc: forged@example.net')
  assert.equal(captured.at(-1).subject, 'Hello Bcc: forged@example.net')
  const count = captured.length
  await send(body)
  assert.equal(captured.length, count, 'Idempotent replay must not send again')
  await send({ ...body, clientId: randomBytes(12).toString('hex') })
  assert.equal(captured.length, count + 1)
  console.log('PASS: Reply-To, explicit Reply all, Spam/Trash persistence, subject sanitization and idempotent sends')

  // Two replies and three compose requests (including the replay) consumed five slots.
  for (let index = 0; index < 5; index++) await send({ ...body, clientId: randomBytes(12).toString('hex') })
  const beforeRateLimit = captured.length
  await api(`/api/mail/mailboxes/${mailbox.channelId}/send`, { method: 'POST', body: { ...body, clientId: randomBytes(12).toString('hex') }, expected: 429 })
  assert.equal(captured.length, beforeRateLimit)
  console.log('PASS: send/reply share the local Durable Object rate limit; rejected requests never reach the gateway')
  docker(['restart', 'llll'])
  let ready = false
  for (let attempt = 0; attempt < 90; attempt++) {
    try { ready = (await fetch(origin + '/api/setup/health')).ok } catch { /* Restarting. */ }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(ready)
  assert.equal((await (await api('/.well-known/llll')).json()).id, discovery.id)
  assert.equal((await (await api(detailPath)).json()).thread.status, 'trash')
  console.log('PASS: UUID, session and Mail state survive a Docker restart')
  await api(`/api/servers/${discovery.id}/mailboxes/${mailbox.channelId}`, { method: 'DELETE', expected: 204 })
  await api(`/api/files/${attachment.id}`, { expected: 404 })
  await api(detailPath, { expected: 404 })
  assert.deepEqual((await (await api('/api/mail/mailboxes')).json()).mailboxes, [])
  console.log('PASS: mailbox deletion revokes conversation and attachment access; blob removal/retry is covered against the real SQL in unit tests')
} finally {
  try { docker(['down', '--volumes']) }
  finally {
    await unlink(envFile).catch(() => {})
    await unlink(override).catch(() => {})
    await new Promise(resolve => gateway.close(resolve))
  }
}
