import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseVersion } from './release-policy.mjs'

export async function buildVpsRelease({ root = resolve(import.meta.dirname, '..'), directory = resolve(root, '.installer/vps'), runtime, version, commit }) {
  parseVersion(version)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('VPS release requires an exact commit')
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const files = {}
  for (const [asset, source] of Object.entries({ 'llll-compose.yml': 'docker-compose.yml', 'compose.vps.yml': 'compose.vps.yml', Caddyfile: 'Caddyfile', 'Caddyfile.vps': 'Caddyfile.vps' })) files[asset] = await readFile(resolve(root, 'self-host', source))
  const pins = Object.entries(files).map(([name, bytes]) => `${digest(bytes)}  ${name}`).join('\n')
  let script = await readFile(resolve(root, 'self-host/install/install.sh'), 'utf8')
  for (const [key, value] of Object.entries({ VERSION: version, COMMIT: commit, RUNTIME_SHA256: digest(await readFile(runtime)), ASSET_PINS: pins })) script = script.replaceAll(`@@${key}@@`, value)
  if (script.includes('@@')) throw new Error('Unresolved VPS installer template')
  await mkdir(directory, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(directory, name), bytes)
  await writeFile(resolve(directory, 'install.sh'), script, { mode: 0o755 })
  // The installed CLI is this same, pinned script; no independent mutable updater.
  await writeFile(resolve(directory, 'llll'), script, { mode: 0o755 })
  await copyFile(runtime, resolve(directory, 'llll-runtime-linux-amd64.tar.gz'))
  console.log(`Built pinned VPS installer ${version} (${commit.slice(0, 7)})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildVpsRelease({
  runtime: resolve(process.env.LLLL_RUNTIME_ARCHIVE || '.installer/runtime/llll-runtime-linux-amd64.tar.gz'),
  version: process.env.RELEASE_VERSION,
  commit: process.env.RELEASE_COMMIT,
})
