import { spawnSync } from 'node:child_process'
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
const root = resolve(import.meta.dirname, '..')
const generated = spawnSync('pnpm', ['exec', 'nuxt', 'generate', 'apps/site'], { cwd: root, stdio: 'inherit' })
if (generated.status !== 0) process.exit(generated.status || 1)
const output = resolve(root, 'apps/site/.output/public')
// Only the release workflow provides a pinned VPS installer. Feature Previews
// return 404 here rather than offering unreleased code to root shells.
if (process.env.LLLL_VPS_INSTALLER) await copyFile(resolve(process.env.LLLL_VPS_INSTALLER), resolve(output, 'install.sh'))
async function paths(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await paths(resolve(directory, entry.name), prefix + '/' + entry.name))
    else if (!entry.name.endsWith('.map')) result.push(prefix + '/' + entry.name)
  }
  return result
}
const assets = (await paths(output)).filter(path => path.startsWith('/_nuxt/') || ['/200.html', '/favicon.svg', '/site.webmanifest'].includes(path))
const hash = createHash('sha256'); for (const path of assets) hash.update(await readFile(output + path))
const cache = 'llll-shell-' + hash.digest('hex').slice(0, 16)
await writeFile(output + '/sw.js', `const CACHE=${JSON.stringify(cache)},ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS.map(path=>new Request(path,{cache:'reload',credentials:'omit'}))))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('llll-shell-')||k.startsWith('l4-shell-'))&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/deploy'))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/200.html')));return;}if(ASSETS.includes(u.pathname))e.respondWith(caches.match(u.pathname).then(r=>r||fetch(e.request)));});`)
await build({ entryPoints: [resolve(root, 'apps/site/src/index.ts')], outfile: resolve(root, 'apps/site/.bundle/index.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', minify: true })
console.log(`Built independent L4 site, iframe shell and PWA (${assets.length} public assets)`)
