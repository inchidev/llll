// Transaction tests of the real release script with a simulated local Docker
// boundary. No VM, real daemon, apt install or public ACME proof is implied.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildVpsRelease } from './build-vps-release.mjs'
import { writeReleaseManifest } from './release-artifacts.mjs'

if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Run in an isolated root Linux container; see docs/vps-installer.md')
if (existsSync('/usr/local/bin/llll')) throw new Error('Use a disposable container without an installed llll CLI')
const root = resolve(import.meta.dirname, '..')
const fixture = mkdtempSync(join(tmpdir(), 'llll-installer-test-'))
const bin = join(fixture, 'bin'), releases = join(fixture, 'releases'), state = join(fixture, 'state'), target = join(fixture, 'instance')
for (const path of [bin, releases, state]) mkdirSync(path)
const first = '9.0.0-alpha.1', next = '9.0.0-alpha.2', broken = '9.0.0-alpha.3'
const versions = [first, next, broken]
for (const [index, version] of versions.entries()) {
  const directory = join(releases, version)
  const runtime = join(fixture, `runtime-${version}`)
  writeFileSync(runtime, `runtime fixture ${version}`)
  await buildVpsRelease({ root, directory, runtime, version, commit: String(index + 1).repeat(40) })
  // Supply the existing release contract's other assets; only the VPS payload is executed.
  for (const file of ['llll.tgz', 'llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', `llll-deployment-core-${version}.tgz`]) writeFileSync(join(directory, file), 'fixture')
  await writeReleaseManifest(directory, { version, commit: String(index + 1).repeat(40), releasePr: index + 1 })
}
const mock = String.raw`#!/usr/bin/env node
import { readFileSync as read, writeFileSync as write, mkdirSync as mkdir, existsSync as exists, rmSync as rm, readdirSync as ls, appendFileSync as append } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const fixture = 'FIXTURE_PATH', state = join(fixture, 'state');
const args = process.argv.slice(2), tool = basename(process.argv[1]);
const get = (name, fallback = '') => exists(join(state, name)) ? read(join(state, name), 'utf8') : fallback;
const save = (name, value) => write(join(state, name), value);
const envFile = path => Object.fromEntries(read(path, 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0,at), line.slice(at+1).replace(/^'|'$/g, '')] }));
const die = (text) => { process.stderr.write(text + '\n'); process.exit(1); };
if (tool === 'uname') { process.stdout.write(args[0] === '-s' ? 'Linux\n' : (process.env.LLLL_TEST_ARCH || 'x86_64') + '\n'); process.exit(); }
if (tool === 'ss') process.exit();
if (tool === 'curl') {
  const url = args.find(x => x.startsWith('https://') || x.startsWith('http://'));
  const out = args[args.indexOf('-o') + 1];
  let bytes;
  if (url.includes('/releases/download/')) {
    const [, version, name] = /\/v([^/]+)\/([^/]+)$/.exec(url);
    try { bytes = read(join(fixture, 'releases', version, name)); } catch { die('fixture asset missing'); }
  } else if (url.endsWith('/.well-known/llll')) {
    if (!get('running')) die('Server is stopped');
    const env = envFile(get('envpath'));
    const data = JSON.parse(read(join(state, env.LLLL_PROJECT + '_celld-data', 'server.json')));
    bytes = Buffer.from(JSON.stringify({ product: 'llll', kind: 'server', id: data.id, origin: env.PUBLIC_ORIGIN, version: env.LLLL_VERSION, ready: data.claimed }));
  } else die('Unexpected network request: ' + url);
  write(out, bytes); process.exit();
}
if (tool !== 'docker') die('Unexpected tool');
// Force the production script to select the local system socket, even with a hostile context.
if (args.shift() !== '--host' || args.shift() !== 'unix:///var/run/docker.sock') die('Docker must be local');
append(join(state, 'calls'), JSON.stringify(args) + '\n');
const cmd = args.shift();
if (cmd === 'version') { console.log('28.0.0'); process.exit(); }
if (cmd === 'load' || cmd === 'pull') { save('mutated', 'yes'); process.exit(); }
if (cmd === 'image') { if (args.includes('--format')) console.log('linux/amd64'); process.exit(); }
if (cmd === 'volume') {
  const action = args.shift();
  const name = action === 'inspect' ? args[0] : args.at(-1);
  const path = join(state, name);
  if (action === 'inspect') {
    if (!exists(path)) process.exit(1);
    if (args.includes('--format')) console.log(get(name + '.owner'));
  } else if (action === 'create') { mkdir(path, { recursive: true }); save(name + '.owner', args[args.indexOf('--label') + 1].split('=')[1]); console.log(name); }
  else if (action === 'rm') { rm(path, { recursive: true }); rm(path + '.owner'); }
  else die('Unexpected volume operation');
  process.exit();
}
if (cmd === 'compose') {
  if (args[0] === 'version') { console.log('2.40.0'); process.exit(); }
  const project = args[args.indexOf('--project-name') + 1];
  const envpath = args[args.indexOf('--env-file') + 1];
  const env = envFile(envpath), action = args[args.lastIndexOf('-f') + 2];
  if (action === 'up' || action === 'start') {
    for (const key of ['rustfs-data','celld-data','caddy-data','caddy-config']) {
      mkdir(join(state, project + '_' + key), { recursive: true }); save(project + '_' + key + '.owner', project);
    }
    const file = join(state, project + '_celld-data', 'server.json');
    if (!exists(file)) write(file, JSON.stringify({ id: randomUUID(), claimed: false, messages: [] }));
    if (env.LLLL_VERSION === '9.0.0-alpha.3') {
      write(file, JSON.stringify({ id: randomUUID(), claimed: false, messages: ['FAILED MIGRATION'] }));
      die('Forced failure after persistent data mutation');
    }
    save('envpath', envpath); save('running', 'yes');
  } else if (action === 'stop' || action === 'down') save('running', '');
  else if (action !== 'ps') die('Unexpected Compose action ' + action);
  process.exit();
}
if (cmd === 'run') {
  const mount = args[args.indexOf('--mount') + 1];
  const name = /src=([^,]+)/.exec(mount)[1], path = join(state, name);
  if (!exists(path)) die('Missing volume');
  if (args.includes('sh')) { if (ls(path).length) process.exit(1); process.exit(); }
  const extracting = args.includes('-xf');
  if (extracting) execFileSync('tar', ['-C', path, '-xf', '-'], { stdio: ['inherit', 'inherit', 'inherit'] });
  else execFileSync('tar', ['-C', path, '-cf', '-', '.'], { stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit();
}
die('Unexpected Docker command: ' + cmd);
`
writeFileSync(join(bin, 'mock.mjs'), mock.replace('FIXTURE_PATH', fixture), { mode: 0o755 })
// Node preserves process.argv[1] for executable scripts invoked through symlinks.
const { symlinkSync } = await import('node:fs')
for (const tool of ['docker', 'curl', 'uname', 'ss']) symlinkSync('mock.mjs', join(bin, tool))
const env = { ...process.env, PATH: bin + ':' + process.env.PATH, LLLL_TEST_FIXTURE: fixture, LLLL_DIR: target, LLLL_BACKUP_DIR: join(fixture, 'backups'), LLLL_DOMAIN: 'server.example.com', LLLL_ADMIN_EMAIL: 'owner@example.com', LLLL_CHANNEL: 'prerelease', LLLL_SKIP_DOCKER_INSTALL: 'true', DOCKER_CONTEXT: 'must-not-use-remote', DOCKER_HOST: 'ssh://must-not-use-remote' }
function run(script, args = [], overrides = {}, success = true) {
  const result = spawnSync('bash', [script, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 })
  if (result.error || (success && result.status !== 0) || (!success && result.status === 0)) throw new Error(`Installer test failed: ${args.join(' ')}\n${result.error || ''}\n${result.stderr}\n${result.stdout.replace(/claim=[^\s]+/g, 'claim=REDACTED')}`)
  return result
}
const script = join(releases, first, 'install.sh')
try {
  run(script, [], { LLLL_TEST_ARCH: 'aarch64' }, false)
  assert.equal(existsSync(target), false)
  run(script, [], { LLLL_CHANNEL: 'stable' }, false)
  assert.equal(existsSync(target), false)
  const runtime = join(releases, first, 'llll-runtime-linux-amd64.tar.gz'), original = readFileSync(runtime)
  writeFileSync(runtime, 'tampered')
  run(script, [], {}, false)
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(join(state, 'mutated')), false, 'tamper must abort before Docker load or installation files')
  writeFileSync(runtime, original)
  const sums = join(releases, first, 'SHA256SUMS'), originalSums = readFileSync(sums)
  writeFileSync(sums, originalSums.toString().replace(/^[a-f0-9]{64}/, '0'.repeat(64)))
  run(script, [], {}, false)
  assert.equal(existsSync(target), false)
  writeFileSync(sums, originalSums)
  run(script)
  const secrets = readFileSync(join(target, '.env'), 'utf8')
  const project = /LLLL_PROJECT='([^']+)'/.exec(secrets)[1]
  const live = join(state, project + '_celld-data', 'server.json'), rustfs = join(state, project + '_rustfs-data', 'file.txt')
  const server = JSON.parse(readFileSync(live))
  writeFileSync(live, JSON.stringify({ ...server, claimed: true, messages: ['preserved message'] }))
  writeFileSync(rustfs, 'preserved private file')
  const rerun = run(script)
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), secrets)
  assert.ok(!rerun.stdout.includes('claim='), 'claimed Servers never print a setup token')
  const cli = join(target, 'llll')
  run(cli, ['backup'])
  const backup = readdirSync(env.LLLL_BACKUP_DIR).find(name => name.endsWith('.tar.gz'))
  run(cli, ['upgrade', next])
  assert.equal(JSON.parse(readFileSync(live)).id, server.id)
  assert.equal(readFileSync(rustfs, 'utf8'), 'preserved private file')
  const upgradedEnv = readFileSync(join(target, '.env'), 'utf8')
  assert.ok(upgradedEnv.includes(next))
  for (const key of ['AUTH_SECRET', 'SETUP_TOKEN', 'RUSTFS_SECRET_KEY', 'RUSTFS_ACCESS_KEY']) assert.equal(new RegExp(`^${key}=.*$`, 'm').exec(upgradedEnv)[0], new RegExp(`^${key}=.*$`, 'm').exec(secrets)[0])
  run(cli, ['upgrade', first], {}, false)
  run(cli, ['upgrade', broken], {}, false)
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), upgradedEnv, 'rollback must restore exact old env')
  assert.deepEqual(JSON.parse(readFileSync(live)), { ...server, claimed: true, messages: ['preserved message'] })
  assert.equal(readFileSync(rustfs, 'utf8'), 'preserved private file')
  run(cli, ['uninstall', '--yes', '--no-backup'])
  assert.ok(existsSync(live), 'default uninstall keeps live volumes')
  // Foreign project protection must fail before purge/backup.
  writeFileSync(join(state, project + '_celld-data.owner'), 'foreign-project')
  run(cli, ['uninstall', '--yes', '--purge', '--no-backup'], {}, false)
  assert.ok(existsSync(live))
  writeFileSync(join(state, project + '_celld-data.owner'), project)
  run(cli, ['uninstall', '--yes', '--purge', '--no-backup'])
  assert.equal(existsSync(live), false)
  assert.ok(existsSync(join(env.LLLL_BACKUP_DIR, backup)), 'purge must preserve backups')
  // Restore into another directory on this simulated fresh host, same identity.
  const restored = join(fixture, 'restored')
  run(cli, ['restore', join(env.LLLL_BACKUP_DIR, backup)], { LLLL_DIR: restored })
  assert.deepEqual(JSON.parse(readFileSync(live)), { ...server, claimed: true, messages: ['preserved message'] })
  assert.equal(readFileSync(rustfs, 'utf8'), 'preserved private file')
  run(join(restored, 'llll'), ['restore', join(env.LLLL_BACKUP_DIR, backup)], { LLLL_DIR: restored }, false)
  // Parser regression: truncated downloads define functions but execute nothing.
  const truncated = join(fixture, 'truncated.sh')
  writeFileSync(truncated, readFileSync(script, 'utf8').replace(/main "\$@"\n$/, ''))
  run(truncated, [], { LLLL_DIR: join(fixture, 'must-not-exist') })
  assert.equal(existsSync(join(fixture, 'must-not-exist')), false)
  console.log('PASS: pinned downloads/tamper, channels/architecture, rerun/secrets, backup/restore/UUID/files, upgrade/downgrade/data rollback, precise uninstall, truncated script, local Docker boundary')
} finally {
  rmSync(fixture, { recursive: true, force: true })
  rmSync('/usr/local/bin/llll', { force: true })
}
