import { spawnSync } from 'node:child_process'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const clientMode = process.argv[2] || 'native'

if (clientMode !== 'native' && clientMode !== 'extension') {
  console.error(`Unknown bundled client mode: ${clientMode}`)
  process.exit(1)
}

const result = spawnSync(pnpm, ['exec', 'nuxt', 'generate'], {
  cwd: process.cwd(),
  env: { ...process.env, LLLL_CLIENT_MODE: clientMode },
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
