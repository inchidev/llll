import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.LLLL_WEB_TEST_PORT || 19003)
const origin = `http://localhost:${port}`
const publicDir = resolve(root, 'apps/site/.output/public')
async function assets(request) {
  let path = decodeURIComponent(new URL(request.url).pathname)
  let file = resolve(publicDir, '.' + path)
  if (file !== publicDir && !file.startsWith(publicDir + '/')) return new Response('Forbidden', { status: 403 })
  // Native auto-trailing-slash canonicalizes standalone HTML files.
  if (path.endsWith('.html') && !path.endsWith('/index.html')) return Response.redirect(origin + path.slice(0, -5), 307)
  let data; let extension = extname(file)
  if (!extname(path)) {
    if (file !== publicDir) {
      try { data = await readFile(file + '.html'); extension = '.html' }
      catch { /* Try a directory index below. */ }
    }
    if (!data) { path = path.replace(/\/$/, '') + '/index.html'; file = resolve(publicDir, '.' + path); extension = '.html' }
  }
  // Match Cloudflare Static Assets: its SPA fallback serves index.html.
  if (!data) {
    try { data = await readFile(file) } catch { data = await readFile(resolve(publicDir, 'index.html')); extension = '.html' }
  }
  return new Response(data, { headers: { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' })[extension] || 'application/octet-stream' } })
}
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port, workers: [{ name: 'web', modules: true, scriptPath: resolve(root, 'apps/site/.bundle/index.mjs'), compatibilityDate: '2026-09-26', d1Databases: { DB: 'web' }, serviceBindings: { ASSETS: assets }, bindings: { PUBLIC_ORIGIN: origin, AUTH_SECRET: 'local-web-test-secret-'.repeat(3), TEST_ALLOW_LOCAL_ORIGINS: 'true' } }] }))
try {
  const db = await mf.getD1Database('DB')
  await db.exec(await readFile(resolve(root, 'apps/site/migrations/0000_web_baseline.sql'), 'utf8'))
  assert.equal((await mf.dispatchFetch(origin + '/')).status, 200)
  const deepLink = await mf.dispatchFetch(origin + '/00000000-0000-4000-8000-000000000001/channels/general')
  assert.equal(deepLink.status, 200)
  assert.equal(await deepLink.text(), await readFile(resolve(publicDir, '200.html'), 'utf8'), 'Server deep links must use the client-only shell entry, not the landing page')
  const config = await (await mf.dispatchFetch(origin + '/api/deploy/config')).json()
  assert.deepEqual(config, { oauth: false })
  assert.equal((await mf.dispatchFetch(origin + '/api/deploy/oauth')).status, 503)
  const forbidden = await mf.dispatchFetch(origin + '/api/servers/register', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forbidden.status, 403)
  console.log('PASS: web assets, installer configuration, unavailable OAuth and cross-origin mutation denial')
  if (process.argv.includes('--serve')) {
    console.log(`Local L4 web: ${origin}`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
} finally { await mf.dispose() }
