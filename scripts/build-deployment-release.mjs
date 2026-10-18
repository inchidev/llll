import { build } from 'esbuild'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const dir = resolve(root, '.installer/deployment')
await mkdir(dir, { recursive: true })
const digest = data => createHash('sha256').update(data).digest('hex')
await build({ entryPoints: [resolve(root, 'apps/client/src/index.ts')], outfile: resolve(root, 'apps/client/.bundle/index.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022' })
await build({ entryPoints: [resolve(root, 'apps/site/src/index.ts')], outfile: resolve(root, 'apps/site/.bundle/index.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022' })
const modules = {}
for (const [name, path] of Object.entries({ server: '.installer/bundle/index.js', client: 'apps/client/.bundle/index.mjs', site: 'apps/site/.bundle/index.mjs' })) {
 const data = await readFile(resolve(root, path)); modules[name] = { content: data.toString('utf8'), sha256: digest(data), size: data.length }
}
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' }
const assets = []
async function walk(path) {
 for (const entry of await readdir(path, { withFileTypes: true })) {
  const file = resolve(path, entry.name)
  if (entry.isDirectory()) await walk(file)
  else {
   const data = await readFile(file)
   assets.push({ path: '/' + relative(resolve(root, '.output/public'), file), hash: createHash('md5').update(data).digest('hex'), size: data.length, contentType: types[extname(file)] || 'application/octet-stream', contentBase64: data.toString('base64') })
  }
 }
}
await walk(resolve(root, '.output/public'))
const migrations = {}
for (const [kind, path] of Object.entries({ server: 'drizzle/migrations' })) {
 const directory = resolve(root, path)
 migrations[kind] = await Promise.all((await readdir(directory)).filter(name => /^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name)).sort().map(async name => ({ name, sql: await readFile(resolve(directory, name), 'utf8') })))
}
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, version: JSON.parse(await readFile(resolve(root, 'package.json'))).version, modules, assets, migrations }))
await writeFile(resolve(dir, 'llll-deployment.json'), bytes)
let sums = `${digest(bytes)}  llll-deployment.json\n`
try {
 await readFile(resolve(root, 'apps/site/.output/public/index.html'))
  const site = resolve(dir, 'llll.tgz')
  execFileSync('tar', ['-czf', site, '-C', resolve(root, 'apps/site'), '.bundle/index.mjs', '.output/public', 'migrations', 'wrangler.jsonc'])
  sums += `${digest(await readFile(site))}  llll.tgz\n`
} catch (error) { if (error.code !== 'ENOENT') throw error }
await writeFile(resolve(dir, 'SHA256SUMS'), sums)
console.log(`Deployment artifact: ${assets.length} assets, ${bytes.length} bytes, SHA256 ${digest(bytes)}`)
