import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = fileURLToPath(new URL('.', import.meta.url))
export const output = resolve(here, '../../../.deployment/opencode-acceptance')
await mkdir(output, { recursive: true })
await build({ entryPoints: [resolve(here, 'worker.mjs')], outfile: resolve(output, 'index.mjs'), bundle: true, format: 'esm', platform: 'node', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['cloudflare:*', 'node:*'], minify: true,
  banner: { js: "import {createRequire} from 'node:module'; const require=createRequire('file:///opencode-probe.mjs');" }, logLevel: 'warning' })
await writeFile(resolve(output, 'wrangler.json'), JSON.stringify({ name: 'llll-opencode-probe-230', main: './index.mjs', no_bundle: true, compatibility_date: '2026-10-03', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false, durable_objects: { bindings: [{ name: 'PROBE', class_name: 'OpenCodeProbe' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['OpenCodeProbe'] }], vars: { PROBE_EXPIRES: String(Date.now() + 86400000) } }))
