import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { sha256, validateReleaseManifest } from '../../scripts/release-artifacts.mjs'

const factoryAssets = ['llll-factory.json', 'llll-compute-node-linux-amd64.tgz', 'llll-workspace-linux-amd64.tar.gz', 'llll-workspace-config.json', 'llll-workspace-manifest.json']
const version = '9.0.0', commit = 'a'.repeat(40)
function release() {
  const files = Object.fromEntries([
    'llll.tgz', 'llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-runtime-linux-amd64.tar.gz',
    'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', `llll-deployment-core-${version}.tgz`, ...factoryAssets,
  ].map(file => [file, { sha256: 'b'.repeat(64), size: 10 }]))
  return { schemaVersion: 3, version, commit, releasePr: 1, components: ['llll', 'server', 'docs'], factoryInstaller: 1, files }
}

it('requires the full optional Factory payload while preserving immutable releases without Factory', () => {
  expect(() => validateReleaseManifest(release(), 'v' + version, commit)).not.toThrow()
  for (const file of factoryAssets) {
    const missing = release()
    Reflect.deleteProperty(missing.files, file)
    expect(() => validateReleaseManifest(missing, 'v' + version, commit)).toThrow('Incomplete Factory release')
    const tampered = release()
    tampered.files[file]!.sha256 = 'not-a-checksum'
    expect(() => validateReleaseManifest(tampered, 'v' + version, commit)).toThrow('Incomplete Factory release')
  }
  const legacy = release()
  Reflect.deleteProperty(legacy, 'factoryInstaller')
  for (const file of factoryAssets) Reflect.deleteProperty(legacy.files, file)
  expect(() => validateReleaseManifest(legacy, 'v' + version, commit)).not.toThrow()
})
it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, '1'])('rejects invalid Factory asset byte counts: %s', size => {
  const manifest = release()
  manifest.files['llll-factory.json']!.size = size as number
  expect(() => validateReleaseManifest(manifest, 'v' + version, commit)).toThrow('Incomplete Factory release')
})
it('builds a portable Node payload and an independently verifiable OCI config/layer digest graph', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llll-factory-release-'))
  const script = resolve('scripts/build-factory-release.mjs'), bin = join(directory, 'bin'), dockerArchive = join(directory, 'docker-save')
  const source = join(directory, 'packages/compute-node/src')
  try {
    mkdirSync(bin); mkdirSync(dockerArchive); mkdirSync(source, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }))
    const daemonSource = 'export const releaseFixture = true\n'
    writeFileSync(join(source, 'daemon.mjs'), daemonSource)
    writeFileSync(join(source, 'state-store.mjs'), 'export const journalFixture = true\n')
    const layers = ['base', 'tools'].map(name => {
      const content = join(directory, name)
      mkdirSync(content); writeFileSync(join(content, name + '.txt'), name + ' layer content\n')
      const target = join(dockerArchive, name + '.tar')
      execFileSync('tar', ['-cf', target, '-C', content, '.'])
      return { name: name + '.tar', bytes: readFileSync(target) }
    })
    const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: layers.map(layer => 'sha256:' + sha256(layer.bytes)) } }))
    const imageId = 'sha256:' + sha256(config)
    writeFileSync(join(dockerArchive, 'config.json'), config)
    writeFileSync(join(dockerArchive, 'manifest.json'), JSON.stringify([{ Config: 'config.json', RepoTags: [`llll-workspace:${version}`], Layers: layers.map(layer => layer.name) }]))
    // The production build script still creates all tar/gzip/OCI assets. Only its
    // trusted Docker boundary is deterministic; no registry or cloud calls occur.
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nconst {execFileSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='build')process.exit(0);if(args[0]==='image'&&args[1]==='inspect'){process.stdout.write(${JSON.stringify(imageId)});process.exit(0)}if(args[0]==='save'){execFileSync('tar',['-cf',args[args.indexOf('-o')+1],'-C',${JSON.stringify(dockerArchive)},'.']);process.exit(0)}process.exit(1)\n`, { mode: 0o755 })
    execFileSync(process.execPath, [script], { cwd: directory, env: { ...process.env, PATH: bin + ':' + process.env.PATH }, timeout: 30000, stdio: 'pipe' })
    const output = join(directory, '.installer/factory')
    const manifest = JSON.parse(readFileSync(join(output, 'llll-factory.json'), 'utf8'))
    expect(manifest).toMatchObject({ schemaVersion: 1, version, image: imageId })
    for (const [file, metadata] of Object.entries(manifest.files) as Array<[string, { sha256: string; size: number }]>) {
      const bytes = readFileSync(join(output, file))
      expect(metadata).toEqual({ sha256: sha256(bytes), size: bytes.length })
    }
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(factoryAssets.filter(file => file !== 'llll-factory.json')))
    const ociBytes = readFileSync(join(output, 'llll-workspace-manifest.json'))
    expect(manifest.manifestDigest).toBe('sha256:' + sha256(ociBytes))
    const oci = JSON.parse(ociBytes.toString())
    expect(oci).toMatchObject({ schemaVersion: 2, config: { digest: imageId, size: config.length }, layers: expect.any(Array) })
    expect(readFileSync(join(output, 'llll-workspace-config.json'))).toEqual(config)
    expect(oci.layers).toHaveLength(layers.length)
    for (const [index, descriptor] of oci.layers.entries()) {
      const entry = manifest.layers[index], compressed = readFileSync(join(output, entry.file))
      expect(entry).toMatchObject(descriptor)
      expect(descriptor.digest).toBe('sha256:' + sha256(compressed))
      expect(descriptor.size).toBe(compressed.length)
      expect(gunzipSync(compressed)).toEqual(layers[index]!.bytes)
    }
    const nodeArchive = join(output, 'llll-compute-node-linux-amd64.tgz')
    expect(execFileSync('tar', ['-xOf', nodeArchive, 'src/daemon.mjs'], { encoding: 'utf8' })).toBe(daemonSource)
    const extracted = join(directory, 'portable-node')
    mkdirSync(extracted)
    execFileSync('tar', ['-xzf', nodeArchive, '-C', extracted])
    expect(execFileSync(join(extracted, 'node'), ['--version'], { encoding: 'utf8' }).trim()).toBe(process.version)
    const saved = join(directory, 'saved-again')
    mkdirSync(saved)
    execFileSync('tar', ['-xzf', join(output, 'llll-workspace-linux-amd64.tar.gz'), '-C', saved])
    expect(JSON.parse(readFileSync(join(saved, 'manifest.json'), 'utf8'))[0].Layers).toEqual(layers.map(layer => layer.name))
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 45000)
it('refuses a changed released image before stopping the pinned service or modifying retained Task state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llll-factory-pin-'))
  const installed = join(directory, 'installed'), stage = join(directory, 'stage'), assets = join(directory, 'release'), source = join(directory, 'source')
  try {
    for (const folder of [installed, stage, assets, source]) mkdirSync(folder)
    mkdirSync(join(installed, 'factory/state'), { recursive: true }); mkdirSync(join(source, 'src'))
    const privateEnv = 'LLLL_WORKSPACE_IMAGE=sha256:' + 'c'.repeat(64) + '\n'
    writeFileSync(join(installed, 'factory/factory.env'), privateEnv)
    writeFileSync(join(installed, 'factory/state/node-state.sqlite'), 'retained private journal fixture')
    writeFileSync(join(installed, 'factory/state/task.img'), 'retained Task disk fixture')
    writeFileSync(join(source, 'node'), 'unused Node payload fixture')
    writeFileSync(join(source, 'src/daemon.mjs'), 'unused daemon payload fixture')
    const nodeAsset = 'llll-compute-node-linux-amd64.tgz', imageAsset = 'llll-workspace-linux-amd64.tar.gz'
    execFileSync('tar', ['-czf', join(assets, nodeAsset), '-C', source, 'node', 'src'])
    writeFileSync(join(assets, imageAsset), 'unused image payload fixture')
    const files = Object.fromEntries([nodeAsset, imageAsset].map(file => [file, { sha256: sha256(readFileSync(join(assets, file))), size: readFileSync(join(assets, file)).length }]))
    writeFileSync(join(assets, 'llll-factory.json'), JSON.stringify({ schemaVersion: 1, version, image: 'sha256:' + 'd'.repeat(64), files }))
    const definitions = readFileSync('self-host/install/install.sh', 'utf8').replace(/main "\$@"\n$/, '')
    const harness = join(directory, 'factory-command.sh')
    writeFileSync(harness, definitions + `
set -euo pipefail
dir="$FACTORY_TEST_INSTALLED"
stage="$FACTORY_TEST_STAGE"
project=factory-fixture
version=9.0.0
need() { :; }
uname() { printf 'x86_64\\n'; }
df() { printf 'Avail\\n12345678900\\n'; }
awk() { if [[ $1 == *MemAvailable:* ]]; then printf '4000000\\n'; else command awk "$@"; fi; }
release_metadata() { base="$FACTORY_TEST_ASSETS"; }
validate_metadata() { :; }
manifest_hash() { sha256sum "$FACTORY_TEST_ASSETS/$1" | cut -d' ' -f1; }
fetch() { cp -- "$1" "$2"; }
systemctl() { printf '%s\\n' "$*" >> "$FACTORY_TEST_CALLS"; }
docker() { printf '%s\\n' "$*" >> "$FACTORY_TEST_CALLS"; }
factory_command enable --trust-shared-kernel
`)
    let rejection = ''
    try {
      execFileSync('bash', [harness], { env: { ...process.env, FACTORY_TEST_INSTALLED: installed, FACTORY_TEST_STAGE: stage, FACTORY_TEST_ASSETS: assets, FACTORY_TEST_CALLS: join(directory, 'host-calls') }, timeout: 10000, stdio: 'pipe' })
    } catch (error) {
      rejection = String((error as { stderr?: Buffer }).stderr)
    }
    expect(rejection).toContain('released image changed')
    expect(readFileSync(join(installed, 'factory/factory.env'), 'utf8')).toBe(privateEnv)
    expect(readFileSync(join(installed, 'factory/state/node-state.sqlite'), 'utf8')).toBe('retained private journal fixture')
    expect(readFileSync(join(installed, 'factory/state/task.img'), 'utf8')).toBe('retained Task disk fixture')
    expect(() => readFileSync(join(directory, 'host-calls'))).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 15000)
