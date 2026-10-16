import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

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
await copyFile(`${output}/index.html`, `${output}/app-shell.html`)
const assets = ['/app-shell.html', '/site.webmanifest', '/favicon.svg', '/brand/logo-128.png', ...await files(`${output}/_nuxt`, '/_nuxt'), ...await files(`${output}/_fonts`, '/_fonts').catch(() => [])]
const hash = createHash('sha256')
for (const path of assets.sort()) hash.update(path).update(await readFile(`${output}${path}`))
const template = await readFile(`${root}/pwa/service-worker.js`, 'utf8')
const push = await readFile(`${root}/public/sw.js`, 'utf8')
await writeFile(`${output}/sw.js`, template.replace('__CACHE_ID__', hash.digest('hex').slice(0, 20)).replace('__PUBLIC_ASSETS__', JSON.stringify(assets)) + '\n' + push)
console.log(`L4 PWA: ${assets.length} public assets; private routes remain network-only`)
