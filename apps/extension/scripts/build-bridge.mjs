import { build } from 'esbuild'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = resolve(root, 'www')
const indexPath = resolve(webDir, 'index.html')

if (!existsSync(indexPath)) {
  console.error(`Extension web build not found at ${indexPath}`)
  process.exit(1)
}

await Promise.all([
  build({
    entryPoints: [resolve(root, 'src/extension-bridge.ts')],
    outfile: resolve(webDir, 'extension-bridge.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome114',
    minify: true,
  }),
  build({
    entryPoints: [resolve(root, 'src/service-worker.ts')],
    outfile: resolve(webDir, 'service-worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome114',
    minify: true,
  }),
])

const marker = '<script src="/extension-bridge.js"></script>'
let html = readFileSync(indexPath, 'utf8')
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/u)

if (importMap) {
  const entry = JSON.parse(importMap[1]).imports?.['#entry']
  if (typeof entry !== 'string' || !entry.startsWith('/_nuxt/')) {
    throw new Error('Nuxt extension build has an unexpected #entry import map')
  }
  const relativeEntry = `./${entry.slice('/_nuxt/'.length)}`
  for (const name of readdirSync(resolve(webDir, '_nuxt')).filter(name => name.endsWith('.js'))) {
    const path = resolve(webDir, '_nuxt', name)
    const source = readFileSync(path, 'utf8')
    const rewritten = source
      .replaceAll('"#entry"', JSON.stringify(relativeEntry))
      .replaceAll("'#entry'", `'${relativeEntry}'`)
    if (rewritten !== source) writeFileSync(path, rewritten)
  }
  html = html.replace(importMap[0], '')
}

let inlineIndex = 0
html = html.replace(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gu, (tag, attributes, source) => {
  if (/\btype="application\/json"/u.test(attributes)) return tag
  if (!source.trim()) return ''
  const name = `extension-inline-${inlineIndex++}.js`
  writeFileSync(resolve(webDir, name), source)
  return `<script${attributes} src="/${name}"></script>`
})

if (!html.includes(marker)) html = html.replace('</head>', `${marker}</head>`)
writeFileSync(indexPath, html)

const pathRewrites = [
  ['_nuxt/', 'assets/'],
  ['_fonts/', 'fonts/'],
]
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.webmanifest'])

function rewriteGeneratedPaths(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteGeneratedPaths(path)
      continue
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'))
    if (!textExtensions.has(extension)) continue
    const source = readFileSync(path, 'utf8')
    const rewritten = pathRewrites.reduce(
      (value, [from, to]) => value.replaceAll(from, to),
      source,
    )
    if (rewritten !== source) writeFileSync(path, rewritten)
  }
}

rewriteGeneratedPaths(webDir)
for (const [from, to] of [['_nuxt', 'assets'], ['_fonts', 'fonts']]) {
  const source = resolve(webDir, from)
  if (existsSync(source)) renameSync(source, resolve(webDir, to))
}

copyFileSync(resolve(root, 'manifest.json'), resolve(webDir, 'manifest.json'))
console.log(`Built Chrome extension at ${webDir}`)
