import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../www', import.meta.url)))

if (!existsSync(root)) throw new Error(`Extension build not found at ${root}`)

const entries = []
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    entries.push(path)
    if (entry.isDirectory()) walk(path)
  }
}
walk(root)

const reserved = entries
  .filter(path => basename(path).startsWith('_'))
  .map(path => relative(root, path))

if (reserved.length) {
  throw new Error(`Chrome-reserved extension paths found:\n${reserved.join('\n')}`)
}

const manifestPath = resolve(root, 'manifest.json')
const indexPath = resolve(root, 'index.html')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const html = readFileSync(indexPath, 'utf8')

if (manifest.manifest_version !== 3 || manifest.side_panel?.default_path !== 'index.html') {
  throw new Error('Invalid MV3 side panel manifest')
}

for (const name of ['extension-bridge.js', 'service-worker.js', 'extension-inline-0.js', 'extension-inline-1.js']) {
  if (!existsSync(resolve(root, name))) throw new Error(`Missing packaged file: ${name}`)
}

const inlineExecutable = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gu)]
  .filter(([, attributes, source]) => !/\btype="application\/json"/u.test(attributes) && source.trim())

if (inlineExecutable.length) throw new Error('Executable inline scripts remain in index.html')
if (html.includes('type="importmap"')) throw new Error('Inline import map remains in index.html')

console.log(`Verified Chrome extension package at ${root}`)
