import { resolve } from 'node:path'
import { cp, mkdir, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { buildNuxt, loadNuxt, useNitro } from 'nuxt/kit'
import { build, prepare } from 'nitropack'
import { createWatchHeadersPlugin } from './watch-headers.mjs'

// Generate Nuxt's server imports and templates without building the Client.
// The production preset/entry stays the same; only Rollup's watch loop is enabled.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.deployment/dev-stack/backend-build')
const published = resolve(root, '.deployment/dev-stack/backend')
const nuxt = await loadNuxt({
  cwd: root,
  dev: false,
  dotenv: false,
  overrides: {
    _prepare: true,
    // Rollup retains the large agent graph between edits. Server source maps
    // make error recovery spend most of its time collecting mapping objects.
    sourcemap: { server: false },
    buildDir: resolve(root, '.deployment/dev-stack/nuxt-backend'),
    nitro: {
      output: { dir: output, serverDir: resolve(output, 'server'), publicDir: resolve(output, 'public') },
      logLevel: 2,
      minify: false,
      sourceMap: false,
    },
    hooks: {
      'nitro:config'(config) {
        // Vite serves the Client. Omitting Nuxt's HTML renderer also avoids
        // depending on a production client manifest during backend development.
        config.handlers = config.handlers.filter(handler => handler.handler !== '#internal/nuxt/renderer')
      },
    },
  },
})
await buildNuxt(nuxt)
const nitro = nuxt.runWithContext(() => useNitro())
nitro.hooks.hook('compiled', async () => {
  // celld reads an immutable snapshot, so another Rollup build cannot change
  // chunks halfway through a deploy. The marker is published last.
  const directory = `build-${Date.now()}`
  await mkdir(published, { recursive: true })
  await cp(output, resolve(published, directory), { recursive: true })
  const marker = resolve(published, '.build.json')
  await writeFile(marker + '.tmp', JSON.stringify({ builtAt: new Date().toISOString(), directory }))
  await rename(marker + '.tmp', marker)
  const previous = (await readdir(published)).filter(name => /^build-\d+$/.test(name)).sort().slice(0, -5)
  for (const name of previous) await rm(resolve(published, name), { recursive: true })
  console.log('llll: backend compiled; celld will adopt this build')
})
await prepare(nitro)
const headersPlugin = await createWatchHeadersPlugin(nitro.options.output.publicDir)
nitro.hooks.hook('rollup:before', (_, config) => {
  config.plugins.unshift(headersPlugin)
})
nitro.options.dev = true
await build(nitro)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    setTimeout(() => process.exit(0), 2500).unref()
    await nuxt.close()
    process.exit(0)
  })
}
