import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webOutput = resolve(root, '.output/public')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const target = process.argv[2] || 'all'
const clients = {
  mobile: { mode: 'native', output: resolve(root, 'apps/mobile/www') },
  desktop: { mode: 'native', output: resolve(root, 'apps/desktop/www') },
  extension: { mode: 'extension', output: resolve(root, 'apps/extension/www') },
}

if (!['all', ...Object.keys(clients)].includes(target)) {
  console.error(`Unknown client web target: ${target}`)
  process.exit(1)
}

const selected = target === 'all'
  ? Object.entries(clients)
  : [[target, clients[target]]]

const modes = [...new Set(selected.map(([, client]) => client.mode))]

for (const mode of modes) {
  const result = spawnSync(pnpm, ['run', `generate:${mode}`], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  if (!existsSync(resolve(webOutput, 'index.html'))) {
    console.error(`${mode} web build did not produce ${resolve(webOutput, 'index.html')}`)
    process.exit(1)
  }

  for (const [name, client] of selected.filter(([, item]) => item.mode === mode)) {
    rmSync(client.output, { recursive: true, force: true })
    cpSync(webOutput, client.output, { recursive: true })
    console.log(`Copied L4 ${mode} web build to ${client.output}`)

    const bridge = spawnSync(pnpm, ['--filter', `@llll/${name}`, 'build:bridge'], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    if (bridge.error) throw bridge.error
    if (bridge.status !== 0) process.exit(bridge.status ?? 1)
  }
}
