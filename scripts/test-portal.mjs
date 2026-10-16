import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.LLLL_PORTAL_TEST_PORT || 19003)
const origin = `http://localhost:${port}`
const publicDir = resolve(root, 'apps/site/.output/public')
async function assets(request) {
  let path = decodeURIComponent(new URL(request.url).pathname)
  if (!extname(path)) path = path.replace(/\/$/, '') + '/index.html'
  const file = resolve(publicDir, '.' + path)
  if (!file.startsWith(publicDir + '/')) return new Response('Forbidden', { status: 403 })
  let data; let extension = extname(file)
  try { data = await readFile(file) } catch { data = await readFile(resolve(publicDir, '200.html')); extension = '.html' }
  return new Response(data, { headers: { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' })[extension] || 'application/octet-stream' } })
}
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port, workers: [{ name: 'portal', modules: true, scriptPath: resolve(root, 'apps/site/.bundle/index.mjs'), compatibilityDate: '2026-09-26', d1Databases: { PORTAL_DB: 'portal' }, serviceBindings: { ASSETS: assets }, bindings: { PUBLIC_ORIGIN: origin, AUTH_SECRET: 'local-portal-test-secret-'.repeat(3), TEST_ALLOW_LOCAL_ORIGINS: 'true' } }] }))
try {
  const db = await mf.getD1Database('PORTAL_DB')
  await db.exec(await readFile(resolve(root, 'apps/site/migrations/0000_portal_baseline.sql'), 'utf8'))
  assert.equal((await mf.dispatchFetch(origin + '/')).status, 200)
  const config = await (await mf.dispatchFetch(origin + '/api/deploy/config')).json()
  assert.deepEqual(config, { oauth: false })
  assert.equal((await mf.dispatchFetch(origin + '/api/deploy/oauth')).status, 503)
  const forbidden = await mf.dispatchFetch(origin + '/api/servers/register', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forbidden.status, 403)
  console.log('PASS: portal assets, installer configuration, unavailable OAuth and cross-origin mutation denial')
  if (process.argv.includes('--serve')) {
    console.log(`Local L4 portal: ${origin}`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
} finally { await mf.dispose() }
