import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.LLLL_WEB_TEST_PORT || 19003)
const origin = `http://localhost:${port}`
const publicDir = resolve(root, 'apps/site/.output/public')
async function assets(request) {
  const path = decodeURIComponent(new URL(request.url).pathname)
  let file = resolve(publicDir, '.' + path)
  if (file !== publicDir && !file.startsWith(publicDir + '/')) return new Response('Forbidden', { status: 403 })
  // Native auto-trailing-slash canonicalizes standalone HTML files.
  if (path.endsWith('.html') && !path.endsWith('/index.html')) return Response.redirect(origin + path.slice(0, -5), 307)
  // Like Cloudflare Static Assets: the exact file, then `<path>.html`, then
  // `<path>/index.html` (versions such as /changelog/v0.3.4 contain dots).
  let data; let extension = extname(file); let status = 200
  // Cloudflare redirects `/page/` to `/page`; serving page.html stands in for that.
  const candidates = path.endsWith('/') ? [resolve(file, 'index.html'), file + '.html'] : [file, file + '.html', resolve(file, 'index.html')]
  for (const candidate of file === publicDir ? [resolve(publicDir, 'index.html')] : candidates) {
    try { data = await readFile(candidate); extension = extname(candidate); break }
    catch { /* Try the next candidate. */ }
  }
  // 404-page handling: missing paths get 404.html.
  if (!data) { data = await readFile(resolve(publicDir, '404.html')); extension = '.html'; status = 404 }
  return new Response(data, { status, headers: { 'Content-Type': ({ '.html': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain', '.xml': 'application/xml', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' })[extension] || 'application/octet-stream' } })
}
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port, workers: [{ name: 'web', modules: true, scriptPath: resolve(root, 'apps/site/.bundle/index.mjs'), compatibilityDate: '2026-09-26', d1Databases: { DB: 'web' }, serviceBindings: { ASSETS: assets }, bindings: { PUBLIC_ORIGIN: origin, AUTH_SECRET: 'local-web-test-secret-'.repeat(3), TEST_ALLOW_LOCAL_ORIGINS: 'true' } }] }))
try {
  const db = await mf.getD1Database('DB')
  await db.exec(await readFile(resolve(root, 'apps/site/migrations/0000_web_baseline.sql'), 'utf8'))
  assert.equal((await mf.dispatchFetch(origin + '/')).status, 200)
  const home = await mf.dispatchFetch(origin + '/servers/')
  assert.equal(home.status, 200)
  assert.match(await home.text(), /<title>My Servers · L4<\/title>/, 'My servers must load directly without the legacy installer redirect')
  const deepLink = await mf.dispatchFetch(origin + '/00000000-0000-4000-8000-000000000001/channels/general')
  assert.equal(deepLink.status, 200)
  const deepLinkHtml = await deepLink.text()
  assert.equal(deepLinkHtml, await readFile(resolve(publicDir, '200.html'), 'utf8'), 'Server deep links must use the client-only shell entry, not the landing page')
  assert.match(deepLinkHtml, /<meta property="og:description" content="One workspace for humans and agents\."/, 'Shared Server links need metadata without JavaScript')
  const docs = await mf.dispatchFetch(origin + '/docs/get-started/what-is-l4')
  assert.equal(docs.status, 200)
  const docsHtml = await docs.text()
  assert.match(docsHtml, /<link rel="canonical" href="https:\/\/llll\.gg\/docs\/get-started\/what-is-l4">/, 'Docs pages need their own canonical URL')
  assert.match(docsHtml, /type="text\/markdown"/, 'Docs pages advertise their Markdown copy')
  const markdown = await mf.dispatchFetch(origin + '/docs/get-started/what-is-l4', { headers: { Accept: 'text/markdown, text/html;q=0.9' } })
  assert.equal(markdown.status, 200)
  assert.match(markdown.headers.get('Content-Type'), /^text\/markdown/)
  assert.match(await markdown.text(), /^# .+\n\n> .+\n\nSource: https:\/\/llll\.gg\/docs\/get-started\/what-is-l4\n/, 'Agents receive Markdown for Accept: text/markdown')
  const homeMarkdown = await mf.dispatchFetch(origin + '/', { headers: { Accept: 'text/markdown' } })
  assert.match(homeMarkdown.headers.get('Content-Type'), /^text\/markdown/)
  assert.match(await homeMarkdown.text(), /^# L4\n/, 'The home page answers Accept: text/markdown with llms.txt')
  assert.match(await (await mf.dispatchFetch(origin + '/robots.txt')).text(), /Content-Signal: search=yes/)
  for (const path of ['/changelog/v0.3.4', '/changelog/v0.3.4.md', '/docs/get-started/what-is-l4.md', '/llms.txt', '/docs/llms.txt', '/docs/llms-full.txt', '/robots.txt', '/sitemap.xml', '/changelog', '/changelog/rss.xml', '/blog', '/blog/rss.xml', '/docs']) {
    const response = await mf.dispatchFetch(origin + path)
    assert.equal(response.status, 200, path)
    if (/\.(?:md|txt|xml)$/.test(path)) assert.doesNotMatch(response.headers.get('Content-Type'), /html/, path)
  }
  assert.match(await (await mf.dispatchFetch(origin + '/sitemap.xml')).text(), /<loc>https:\/\/llll\.gg\/docs\/cloudflare\/overview<\/loc>/)
  const missing = await mf.dispatchFetch(origin + '/no-such-page')
  assert.equal(missing.status, 404, 'Unknown paths are real 404s, not the landing page')
  const config = await (await mf.dispatchFetch(origin + '/api/deploy/config')).json()
  assert.deepEqual(config, { oauth: false })
  assert.equal((await mf.dispatchFetch(origin + '/api/deploy/oauth')).status, 503)
  const forbidden = await mf.dispatchFetch(origin + '/api/servers/register', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forbidden.status, 403)
  console.log('PASS: web assets, docs and agent files, real 404s, installer configuration, unavailable OAuth and cross-origin mutation denial')
  if (process.argv.includes('--serve')) {
    console.log(`Local L4 web: ${origin}`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
} finally { await mf.dispose() }
