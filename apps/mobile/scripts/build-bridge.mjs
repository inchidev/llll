import { build } from 'esbuild'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = resolve(root, 'www')
const indexPath = resolve(webDir, 'index.html')
const outputPath = resolve(webDir, 'native-bridge.js')

if (!existsSync(indexPath)) {
  console.error(`Mobile web build not found at ${indexPath}`)
  process.exit(1)
}

await build({
  entryPoints: [resolve(root, 'src/native-bridge.ts')],
  outfile: outputPath,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari15',
  minify: true,
})

const marker = '<script src="/native-bridge.js"></script>'
const html = readFileSync(indexPath, 'utf8')
if (!html.includes(marker)) {
  writeFileSync(indexPath, html.replace('</head>', `${marker}</head>`))
}

console.log(`Built mobile native bridge at ${outputPath}`)
