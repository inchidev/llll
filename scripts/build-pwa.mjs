import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderPublicServiceWorker } from './pwa-source.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.output/public')
const generated = spawnSync('pnpm', ['exec', 'nuxt', 'generate'], { cwd: root, env: { ...process.env, LLLL_STATIC_CLIENT: 'true' }, stdio: 'inherit' })
if (generated.status !== 0) process.exit(generated.status || 1)
await cp(resolve(root, '.client-output/public'), output, { recursive: true })
async function files(directory, prefix = '') {
  const paths = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) paths.push(...await files(`${directory}/${item.name}`, `${prefix}/${item.name}`))
    else if (!item.name.endsWith('.map')) paths.push(`${prefix}/${item.name}`)
  }
  return paths
}
// Every document must come from the Worker, which sends this Server's CSP and frame-ancestors.
// Static assets bypass it, so no generated page may stay public: the precached shell is
// fetched from the Worker route /app-shell instead.
const shell = await readFile(`${output}/index.html`)
for (const path of await files(output)) if (path.endsWith('.html')) await rm(`${output}${path}`)
const assets = ['/app-shell', '/site.webmanifest', '/favicon.svg', '/brand/logo-128.png', ...await files(`${output}/_nuxt`, '/_nuxt'), ...await files(`${output}/_fonts`, '/_fonts').catch(() => [])]
const hash = createHash('sha256')
for (const path of assets.sort()) hash.update(path).update(path === '/app-shell' ? shell : await readFile(`${output}${path}`))
const template = await readFile(`${root}/pwa/service-worker.js`, 'utf8')
const push = await readFile(`${root}/public/sw.js`, 'utf8')
await writeFile(`${output}/sw.js`, renderPublicServiceWorker(template, hash.digest('hex').slice(0, 20), assets) + '\n' + push)
console.log(`L4 PWA: ${assets.length} public assets; private routes remain network-only`)
