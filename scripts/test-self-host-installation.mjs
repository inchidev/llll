import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const directory = resolve(process.argv[2] || '.deployment/compose-validation')
const deployment = JSON.parse(await readFile(resolve(directory, 'compose.json'), 'utf8'))
const origin = deployment.services.installation.environment.PUBLIC_ORIGIN
const servers = JSON.parse(await readFile(resolve(directory, 'servers.json'), 'utf8'))
const claim = new URL((await readFile(resolve(directory, 'owner-claim.txt'), 'utf8')).trim())
let token = ''
async function api(path, body) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.equal(response.status < 300, true, `${path} returned ${response.status}: ${await response.clone().text()}`)
  token = response.headers.get('set-auth-token') || token
  return response.json()
}
for (let attempt = 0; ; attempt++) {
  const response = await fetch(origin + '/.well-known/llll').catch(() => null)
  if (response?.ok) break
  if (attempt >= 120) throw new Error('Installation failed to become ready')
  await new Promise(resolve => setTimeout(resolve, 2000))
}
await api('/api/installation/setup', { token: new URLSearchParams(claim.hash.slice(1)).get('claim'), email: 'operator@example.com', name: 'Operator', password: 'ComposeIntegrationPassword123!' })
for (const server of servers) await api('/api/installation/servers/register', server)
for (const server of servers) {
  let me
  for (let attempt = 0; ; attempt++) {
    try { me = await api(`/s/${server.id}/api/me`); break }
    catch (error) { if (attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 2000)) }
  }
  assert.equal(me.user.displayName, 'Operator')
  const dbChannels = await api(`/s/${server.id}/api/workspaces/main/channels`)
  const general = dbChannels.channels.find(channel => channel.name === 'general')
  assert.ok(general)
  const message = await api(`/s/${server.id}/api/channels/${general.id}/messages`, { content: `Private ${server.id} conversation`, clientId: crypto.randomUUID() })
  assert.equal(message.message.content, `Private ${server.id} conversation`)
  server.channelId = general.id
}
assert.notEqual(servers[0].channelId, servers[1]?.channelId)
if (servers.length > 1) {
  const denied = await fetch(`${origin}/s/${servers[1].id}/api/channels/${servers[0].channelId}/messages`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } })
  assert.equal(denied.status, 404)
}
console.log('PASS: celld installation setup, two private server fleets, owner bootstrap, chat and cross-server isolation')
