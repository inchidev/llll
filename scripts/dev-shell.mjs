import { spawn } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { context } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const root = resolve(import.meta.dirname, '..')
const state = resolve(root, '.deployment/dev-stack/shell')
await mkdir(state, { recursive: true })
// Populate the Shell's default tsconfig references before its separate HMR build directory is selected.
await new Promise((accept, reject) => {
  const prepare = spawn('pnpm', ['exec', 'nuxt', 'prepare', 'apps/site'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', LLLL_DEV_SHELL_API_ORIGIN: '' }, stdio: 'inherit' })
  prepare.once('error', reject)
  prepare.once('exit', code => code === 0 ? accept() : reject(new Error(`Shell preparation failed (${code})`)))
})
const bundle = resolve(state, 'worker.mjs')
const origin = process.env.LLLL_SHELL_ORIGIN
const port = Number(new URL(origin).port)
let mf
let frontend
let closing = false
const builder = await context({
  entryPoints: [resolve(root, 'apps/site/src/index.ts')],
  outfile: bundle,
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  plugins: [{
    name: 'local-shell-api',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length || closing) return
        const options = convertV4MiniflareOptions({
          host: '127.0.0.1', port: mf ? Number((await mf.ready).port) : 0,
          d1Persist: resolve(state, 'd1'),
          workers: [{
            name: 'local-shell', modules: true, scriptPath: bundle,
            compatibilityDate: '2026-09-26',
            d1Databases: { DB: 'local-shell' },
            bindings: {
              PUBLIC_ORIGIN: origin,
              AUTH_SECRET: process.env.AUTH_SECRET,
              TEST_ALLOW_LOCAL_ORIGINS: 'true',
            },
          }],
        })
        if (mf) { await mf.setOptions(options); return }
        mf = new Miniflare(options)
        const apiOrigin = (await mf.ready).origin
        const db = await mf.getD1Database('DB')
        const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='server_directory'").first()
        if (!existing) await db.exec(await readFile(resolve(root, 'apps/site/migrations/0000_web_baseline.sql'), 'utf8'))
        frontend = spawn('pnpm', ['exec', 'nuxt', 'dev', 'apps/site', '--host', '127.0.0.1', '--port', String(port), '--dotenv', resolve(root, '.deployment/dev-stack/frontend.env')], {
          cwd: root,
          env: { ...process.env, LLLL_DEV_SHELL_API_ORIGIN: apiOrigin },
          stdio: 'inherit',
        })
        frontend.once('exit', code => { if (!closing) process.exit(code || 1) })
      })
    },
  }],
})
await builder.rebuild()
await builder.watch()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    closing = true
    frontend?.kill('SIGTERM')
    await builder.dispose()
    await mf?.dispose()
    process.exit(0)
  })
}
