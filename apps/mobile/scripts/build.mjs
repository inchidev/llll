import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The app bundles only the device-local Server list and the native bridge.
// Each Server's Client is loaded from that Server, so it always matches its
// Server's version.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = resolve(root, 'www')

rmSync(webDir, { recursive: true, force: true })
mkdirSync(webDir, { recursive: true })

const options = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari16',
  minify: true,
}

await build({ ...options, entryPoints: [resolve(root, 'src/shell.ts')], outfile: resolve(webDir, 'shell.js') })
await build({ ...options, entryPoints: [resolve(root, 'src/native-bridge.ts')], outfile: resolve(webDir, 'native-bridge.js') })
await build({ ...options, entryPoints: [resolve(root, 'src/rail.ts')], outfile: resolve(webDir, 'rail.js') })
await build({ ...options, entryPoints: [resolve(root, 'src/mark.ts')], outfile: resolve(webDir, 'mark.js'), alias: { '~~': resolve(root, '../..') } })
await build({ ...options, entryPoints: [resolve(root, 'src/native-bridge.android.ts')], outfile: resolve(webDir, 'native-bridge-android.js') })
for (const file of ['index.html', 'shell.css', 'mark.html', 'mark.css', 'rail.html', 'rail.css']) cpSync(resolve(root, '../../packages/native-shell', file), resolve(webDir, file))

console.log(`Built mobile shell at ${webDir}`)
