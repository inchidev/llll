import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
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
  target: 'safari15',
  minify: true,
}

await build({ ...options, entryPoints: [resolve(root, 'src/shell.ts')], outfile: resolve(webDir, 'shell.js') })
await build({ ...options, entryPoints: [resolve(root, 'src/native-bridge.ts')], outfile: resolve(webDir, 'native-bridge.js') })
await build({ ...options, entryPoints: [resolve(root, 'src/rail.ts')], outfile: resolve(webDir, 'rail.js') })
await build({ ...options, entryPoints: [resolve(root, 'src/mark.ts')], outfile: resolve(webDir, 'mark.js'), alias: { '~~': resolve(root, '../..') } })
for (const file of ['index.html', 'shell.css', 'mark.html', 'mark.css', 'rail.html', 'rail.css']) cpSync(resolve(root, '../../packages/native-shell', file), resolve(webDir, file))

console.log(`Built desktop shell at ${webDir}`)

// Tauri bundles the Share menu extension but can't build it, so it is compiled here.
if (process.platform === 'darwin') {
  const extension = resolve(root, 'share-extension')
  const appex = resolve(extension, 'build/L4Share.appex')
  rmSync(resolve(extension, 'build'), { recursive: true, force: true })
  mkdirSync(resolve(appex, 'Contents/MacOS'), { recursive: true })
  cpSync(resolve(extension, 'Info.plist'), resolve(appex, 'Contents/Info.plist'))
  const run = (command, ...args) => execFileSync(command, args, { stdio: 'inherit' })
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const output = resolve(extension, `build/L4Share-${arch}`)
    run('xcrun', '--sdk', 'macosx', 'swiftc', '-O', '-parse-as-library', '-module-name', 'L4Share', '-target', `${arch}-apple-macos12`, '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain', '-framework', 'Cocoa', '-framework', 'UniformTypeIdentifiers', resolve(extension, 'ShareViewController.swift'), '-o', output)
    return output
  })
  run('lipo', '-create', ...slices, '-output', resolve(appex, 'Contents/MacOS/L4Share'))
  run('codesign', '--force', '--sign', process.env.APPLE_SIGNING_IDENTITY || '-', '--options', 'runtime', '--entitlements', resolve(extension, 'L4Share.entitlements'), appex)

  console.log(`Built Share extension at ${appex}`)
}
