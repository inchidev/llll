import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from '../../ci-only.mjs'
requireWorkersBuild()
if (!process.env.OPENCODE_PROBE_TOKEN) throw new Error('The temporary probe token is missing')
const output = resolve(import.meta.dirname, '../../../.deployment/opencode-acceptance')
const secrets = resolve(output, 'secrets.json')
await writeFile(secrets, JSON.stringify({ PROBE_TOKEN: process.env.OPENCODE_PROBE_TOKEN }), { mode: 0o600 })
const result = spawnSync('npx', ['wrangler', 'deploy', '--config', resolve(output, 'wrangler.json'), '--secrets-file', secrets], { cwd: import.meta.dirname, stdio: 'inherit' })
process.exit(result.status ?? 1)
