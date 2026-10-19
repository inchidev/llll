import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const violations = []
async function scan(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) { await scan(path); continue }
    if (!/\.(?:ts|vue|mjs|sql|json|jsonc|md)$/.test(path)) continue
    const text = await readFile(resolve(root, path), 'utf8')
    if (/workspace|installation|\bInstance\b|apps\/instance/i.test(path + '\n' + text)) violations.push(relative(root, resolve(root, path)))
  }
}
for (const directory of ['app', 'server', 'shared', 'workers', 'drizzle', 'packages/deployment-core/src', 'apps/site/app', 'apps/site/src']) await scan(directory)
if (violations.length) throw new Error('Retired product terminology in active sources: ' + violations.join(', '))
console.log('Server model: active sources and schema use only the current domain')
