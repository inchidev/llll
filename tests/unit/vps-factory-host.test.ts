import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sha256 } from '../../scripts/release-artifacts.mjs'

const definitions = readFileSync('self-host/install/install.sh', 'utf8').replace(/main "\$@"\n$/, '')
const version = '9.0.0'

function run(script: string, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'llll-vps-host-'))
  const harness = join(directory, 'harness.sh')
  writeFileSync(harness, definitions + '\nset -euo pipefail\n' + script)
  try {
    return execFileSync('bash', [harness], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

it('binds loopback HTTP to 127.0.0.1 and public TLS to every interface', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llll-bind-'))
  try {
    const stage = join(directory, 'stage')
    mkdirSync(stage)
    const loopback = run(`
dir=${JSON.stringify(directory)}
stage=${JSON.stringify(stage)}
pinned_version=${version}
channel=stable
LLLL_DOMAIN=127.0.0.1 LLLL_ADMIN_EMAIL=owner@example.com LLLL_NO_TLS=true LLLL_HTTP_PORT=8081 LLLL_HTTPS_PORT=8444
configure_new
sed -n "s/^LLLL_BIND='\\(.*\\)'/\\1/p" "$stage/.env"
`)
    expect(loopback.trim()).toBe('127.0.0.1')
    const published = run(`
dir=${JSON.stringify(directory)}
stage=${JSON.stringify(stage)}
pinned_version=${version}
channel=stable
LLLL_DOMAIN=example.com LLLL_ADMIN_EMAIL=owner@example.com LLLL_NO_TLS=false
configure_new
sed -n "s/^LLLL_BIND='\\(.*\\)'/\\1/p" "$stage/.env"
`)
    expect(published.trim()).toBe('0.0.0.0')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'linux')('creates a missing lock directory and names the failure when it cannot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llll-lock-'))
  const locks = join(directory, 'locks')
  const blocked = join(directory, 'not-a-directory')
  writeFileSync(blocked, 'file')
  try {
    run(`dir=/opt/llll\nLLLL_LOCK_DIR=${JSON.stringify(locks)}\nlock_installation\n`)
    expect(readFileSync(join(locks, 'llll-' + execFileSync('bash', ['-c', `printf %s /opt/llll | sha256sum | cut -c1-16`], { encoding: 'utf8' }).trim() + '.lock'))).toBeDefined()
    let rejection = ''
    try { run(`dir=/opt/llll\nLLLL_LOCK_DIR=${JSON.stringify(blocked)}\nlock_installation\n`) }
    catch (error) { rejection = String((error as { stderr?: Buffer }).stderr) }
    expect(rejection).toContain('Cannot create the installer lock directory')
    expect(rejection).not.toContain('No such file or directory')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('reports a rerun Factory request and keeps a failed optional Factory from failing the Server install', () => {
  const notice = run(`
dir=/opt/missing
LLLL_FACTORY=true
factory_rerun_notice
`)
  expect(notice).toContain('sudo llll factory enable --trust-shared-kernel')
  const quiet = run(`
dir=$(mktemp -d)
mkdir -p "$dir/factory"
printf 'LLLL_WORKSPACE_IMAGE=sha256:${'a'.repeat(64)}\\n' > "$dir/factory/factory.env"
LLLL_FACTORY=true
factory_rerun_notice
`)
  expect(quiet).toBe('')
  const installed = run(`
factory_command() { fail 'No such image: sha256:${'c'.repeat(64)}'; }
LLLL_FACTORY=true
pinned_version=${version}
enable_optional_factory
`)
  expect(installed).toContain('Server installed. Optional Factory did not start.')
  expect(installed).toContain('--no-systemd')
})

it('prints progress while Server containers are still starting', () => {
  const output = run(`
compose() { sleep 2; }
compose_up
`, { LLLL_COMPOSE_POLL: '1' })
  expect(output).toContain('Waiting for Server containers')
  expect(output).toContain('Still waiting for Server containers')
})

it('fails Factory status and logs before calling systemd when it is not running', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llll-no-systemd-'))
  const calls = join(directory, 'calls')
  try {
    const harness = join(directory, 'harness.sh')
    writeFileSync(harness, definitions + `
set -euo pipefail
dir=/opt/llll
project=factory-fixture
version=${version}
systemctl() { printf '%s\\n' "$*" >> ${JSON.stringify(calls)}; }
journalctl() { printf '%s\\n' "$*" >> ${JSON.stringify(calls)}; exit 0; }
factory_command status
`)
    const status = execFileSync('bash', [harness], { env: { ...process.env, LLLL_SYSTEMD_DIR: join(directory, 'missing') }, encoding: 'utf8', timeout: 10000 })
    expect(status).toContain('never')
  } catch (error) {
    const rejection = String((error as { stderr?: Buffer; stdout?: Buffer }).stderr)
    expect(rejection).toContain('systemd')
    expect(() => readFileSync(calls)).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

function factoryEnable(loadedId: string, pins: { image: string; configDigest?: string; indexDigest?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'llll-factory-load-'))
  const installed = join(directory, 'installed')
  const stage = join(directory, 'stage')
  const assets = join(directory, 'release')
  const source = join(directory, 'source')
  const calls = join(directory, 'calls')
  mkdirSync(installed); mkdirSync(stage); mkdirSync(assets); mkdirSync(join(source, 'src'), { recursive: true })
  writeFileSync(join(installed, '.env'), "PUBLIC_ORIGIN='http://127.0.0.1:8081'\n")
  writeFileSync(join(source, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(join(source, 'node'), 0o755)
  writeFileSync(join(source, 'LICENSE.node'), 'license\n')
  writeFileSync(join(source, 'src/daemon.mjs'), 'export {}\n')
  const nodeAsset = 'llll-compute-node-linux-amd64.tgz'
  const imageAsset = 'llll-workspace-linux-amd64.tar.gz'
  execFileSync('tar', ['-czf', join(assets, nodeAsset), '-C', source, 'node', 'LICENSE.node', 'src'])
  writeFileSync(join(assets, imageAsset), 'workspace image fixture')
  const files = Object.fromEntries([nodeAsset, imageAsset].map(file => {
    const bytes = readFileSync(join(assets, file))
    return [file, { sha256: sha256(bytes), size: bytes.length }]
  }))
  writeFileSync(join(assets, 'llll-factory.json'), JSON.stringify({ schemaVersion: 1, version, ...pins, files }))
  const harness = join(directory, 'harness.sh')
  writeFileSync(harness, definitions + `
set -euo pipefail
dir=${JSON.stringify(installed)}
stage=${JSON.stringify(stage)}
project=factory-fixture
version=${version}
need() { :; }
uname() { printf 'x86_64\\n'; }
df() { printf 'Avail\\n23456789000\\n'; }
awk() { if [[ $1 == *MemAvailable:* ]]; then printf '4000000\\n'; else command awk "$@"; fi; }
release_metadata() { base=${JSON.stringify(assets)}; }
validate_metadata() { :; }
manifest_hash() { sha256sum ${JSON.stringify(assets)}/$1 | cut -d' ' -f1; }
fetch() { cp -- "$1" "$2"; }
systemctl() { printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(calls)}; }
docker() {
  if [[ $1 == load ]]; then return 0; fi
  if [[ $1 == image && $2 == inspect ]]; then
    case "$*" in
      *'{{.Id}}'*) printf '%s\\n' "$FACTORY_LOADED_ID" ;;
      *'{{.Os}}'*) printf 'linux/amd64\\n' ;;
      *) return 1 ;;
    esac
    return 0
  fi
  printf 'docker %s\\n' "$*" >> ${JSON.stringify(calls)}
}
factory_command enable --trust-shared-kernel --no-systemd
`)
  return { directory, installed, calls, harness }
}

it('accepts the config digest on a classic store and the index id on containerd', () => {
  const index = 'sha256:' + 'c'.repeat(64)
  const config = 'sha256:' + '3'.repeat(64)
  const classic = factoryEnable(config, { image: index, configDigest: config, indexDigest: index })
  try {
    execFileSync('bash', [classic.harness], { env: { ...process.env, FACTORY_LOADED_ID: config }, encoding: 'utf8', timeout: 15000 })
    expect(readFileSync(join(classic.installed, 'factory/factory.env'), 'utf8')).toContain('LLLL_WORKSPACE_IMAGE=' + config)
    expect(() => readFileSync(classic.calls, 'utf8')).toThrow()
  } finally { rmSync(classic.directory, { recursive: true, force: true }) }
  const containerd = factoryEnable(index, { image: index, configDigest: config, indexDigest: index })
  try {
    execFileSync('bash', [containerd.harness], { env: { ...process.env, FACTORY_LOADED_ID: index }, encoding: 'utf8', timeout: 15000 })
    expect(readFileSync(join(containerd.installed, 'factory/factory.env'), 'utf8')).toContain('LLLL_WORKSPACE_IMAGE=' + index)
  } finally { rmSync(containerd.directory, { recursive: true, force: true }) }
})

it('refuses a loaded image that matches none of the published digests', () => {
  const index = 'sha256:' + 'c'.repeat(64)
  const config = 'sha256:' + '3'.repeat(64)
  const unknown = 'sha256:' + 'e'.repeat(64)
  const fixture = factoryEnable(unknown, { image: index, configDigest: config, indexDigest: index })
  try {
    let rejection = ''
    try { execFileSync('bash', [fixture.harness], { env: { ...process.env, FACTORY_LOADED_ID: unknown }, encoding: 'utf8', timeout: 15000 }) }
    catch (error) { rejection = String((error as { stderr?: Buffer }).stderr) }
    expect(rejection).toContain('does not match a published Factory digest')
    expect(() => readFileSync(join(fixture.installed, 'factory/factory.env'))).toThrow()
  } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
})
