import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
await mkdir(resolve(root, 'apps/installation/.bundle'), { recursive: true })
await build({ entryPoints: [resolve(root, 'apps/installation/src/index.ts')], outfile: resolve(root, 'apps/installation/.bundle/index.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], sourcemap: false, minify: true })

for (const app of ['client', 'site']) await build({ entryPoints: [resolve(root, `apps/${app}/src/index.ts`)], outfile: resolve(root, `apps/${app}/.bundle/index.mjs`), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', minify: true })
