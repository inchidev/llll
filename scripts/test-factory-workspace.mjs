// Real Docker: the Agent's box and what leaves it (ADR 0010). A box image checks out a Task disk, the box
// runtime answers on its control socket with no network, the Agent commits in it (a lockfile, a binary file
// and a booby-trapped Git config), and the daemon's publish chain runs as on a VPS Node: a throwaway copy
// with no network and the box disk read-only, its review, and a push of exactly the approved commit to a
// local Git server standing in for the repository, which applies the Server's receive-pack check. Under a
// direct_push Git flow the same commit then goes to the base branch, as a fast-forward only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const image = process.env.LLLL_FACTORY_TEST_IMAGE || 'l4-workspace:test'
const root = resolve(import.meta.dirname, '..'), suffix = randomUUID().slice(0, 8), boxId = randomUUID(), approvalId = randomUUID()
const directory = await mkdtemp(join(tmpdir(), 'l4-box-docker-'))
const names = { volume: `l4-test-disk-${suffix}`, box: `l4-test-box-${suffix}`, server: `l4-test-git-${suffix}`, direct: `l4-test-direct-${suffix}` }
const ref = `refs/heads/l4-agent/${boxId}`, capability = 'a'.repeat(64)

function run(command, args, { input, allowFailure = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 || allowFailure ? done({ code, stdout, stderr }) : reject(new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${stderr.slice(-800)}`)))
    child.stdin.end(input)
  })
}
const docker = async (args, options) => (await run('docker', args, options)).stdout.trim()
const git = async (cwd, ...args) => (await run('git', ['-C', cwd, ...args])).stdout.trim()
const json = output => { const line = output.trim().split('\n').filter(Boolean).at(-1); if (!line) throw new Error('No answer'); return JSON.parse(line) }
const hardened = ['--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '1g', '--cpus', '1',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000']
const serverLogs = async () => { const { stdout, stderr } = await run('docker', ['logs', names.server], { allowFailure: true }); return stdout + stderr }
const inBox = command => docker(['exec', names.box, 'sh', '-c', command])
/** A scratch disk as the daemon gives one to each copy: a fresh directory the copy's uid may write. */
async function scratch(name) { const path = join(directory, name); await mkdir(path); await chmod(path, 0o777); return path }
async function copy(mirror, sha, baseSha, review) {
  return json(await docker(['run', '--rm', '-i', '--network', 'none', ...hardened, '--mount', `type=volume,src=${names.volume},dst=/box,readonly`,
    '--mount', `type=bind,src=${mirror},dst=/mirror`, image, 'node', '/opt/l4/review-diff.mjs'], { input: JSON.stringify({ sha, baseSha, review }), allowFailure: true }))
}
async function push(mirror, sha, expectedOld, { server = names.server, target = ref, fastForward = false } = {}) {
  // The push shares the stand-in server's network namespace, so the repository is at 127.0.0.1.
  return json(await docker(['run', '--rm', '-i', '--network', `container:${server}`, ...hardened, '--env', 'LLLL_PUSH_INSECURE_LOCAL=1',
    '--mount', `type=bind,src=${mirror},dst=/mirror`, image, 'node', '/opt/l4/push-branch.mjs'],
  { input: JSON.stringify({ remote: `http://127.0.0.1:8080/api/compute-agent/publish/${approvalId}.git`, ref: target, sha, expectedOld, ...(fastForward ? { fastForward } : {}), authorization: `Bearer ${capability}` }), allowFailure: true }))
}
/** The stand-in repository with the receive-pack check for one approved update. */
async function gitServer(name, remote, environment) {
  const owner = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000'
  await docker(['run', '-d', '--name', name, '--network', 'none', '--user', owner, '--read-only', '--tmpfs', '/tmp:rw,size=64m',
    '--mount', `type=bind,src=${join(root, 'shared')},dst=/opt/shared,readonly`, '--mount', `type=bind,src=${join(root, 'scripts')},dst=/opt/scripts,readonly`,
    '--mount', `type=bind,src=${remote},dst=/remote`, ...Object.entries({ ...environment, CAPABILITY: capability, APPROVAL: approvalId }).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image, 'node', '/opt/scripts/test-factory-git-server.mjs'])
  for (let attempt = 0; attempt < 50 && !(await docker(['logs', name], { allowFailure: true })).includes('listening'); attempt++) await new Promise(done => setTimeout(done, 200))
}

try {
  // The repository the Task is pinned to.
  const source = join(directory, 'source')
  await mkdir(source)
  await git(source, 'init', '-q', '-b', 'main'); await git(source, 'config', 'user.name', 'Existing Author'); await git(source, 'config', 'user.email', 'existing@example.invalid')
  await writeFile(join(source, 'answer.mjs'), 'export const answer = 1\n'); await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Existing canonical history')
  const baseSha = await git(source, 'rev-parse', 'HEAD')
  await git(source, 'bundle', 'create', join(directory, 'source.bundle'), '--all')
  await chmod(join(directory, 'source.bundle'), 0o644)

  // The Task disk, owned by the box's uid as a Node's hard-quota disk is, and its first checkout.
  await docker(['volume', 'create', '--label', 'l4.test=factory', names.volume])
  await docker(['run', '--rm', '--user', '0:0', '--network', 'none', '--mount', `type=volume,src=${names.volume},dst=/work`, image, 'chown', '1000:1000', '/work'])
  assert.equal(json(await docker(['run', '--rm', '-i', '--network', 'none', ...hardened, '--mount', `type=volume,src=${names.volume},dst=/work`,
    '--mount', `type=bind,src=${join(directory, 'source.bundle')},dst=/bootstrap/source.bundle,readonly`, image, 'node', '/opt/agent/src/checkout.mjs'], { input: JSON.stringify({ baseSha }) })).ok, true)

  // The box: long-lived, read-only, uid 1000, no network here, answering on its control socket.
  await docker(['run', '-d', '--name', names.box, '--network', 'none', '--init', ...hardened.filter(value => !['--pids-limit', '64'].includes(value)), '--pids-limit', '256',
    '--tmpfs', '/run/l4:rw,noexec,nosuid,size=1m,uid=1000,gid=1000', '--mount', `type=volume,src=${names.volume},dst=/work`, '--env', 'HOME=/tmp', image, 'node', '/opt/agent/src/box.mjs'])
  const health = json(await docker(['exec', '-i', names.box, 'node', '/opt/agent/src/control.mjs'], { input: JSON.stringify({ op: 'health' }) }))
  assert.deepEqual(health, { status: 'ready', checkout: true })
  assert.equal(await inBox('cd /work/repo && git rev-parse HEAD && git remote | wc -l'), `${baseSha}\n0`)

  // The Agent works with plain Git: a change, a large lockfile and a binary sprite, then a trap for whoever reads the repository.
  await inBox(`cd /work/repo && echo 'export const answer = 42' > answer.mjs && node -e "require('fs').writeFileSync('package-lock.json', JSON.stringify({ packages: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => ['node_modules/p' + i, { version: '1.0.' + i, integrity: 'sha512-' + 'x'.repeat(80) }])) }))" && printf '\\211PNG\\r\\n\\032\\n\\000\\001\\377' > sprite.png && git add -A && git commit -qm 'Answer the question' && git rev-parse HEAD`)
  const sha = await inBox('cd /work/repo && git rev-parse HEAD')
  assert.ok((await stat(join(directory, 'source.bundle'))).size > 0)
  // Each runs only where /mirror exists, the trusted copy's scratch disk; in the box itself it does nothing.
  const trap = 'test -d /mirror && touch /mirror/box-config-ran; true'
  await inBox(`cd /work/repo && git config core.fsmonitor '${trap}' && git config diff.external '${trap}' && mkdir -p .hooks && printf '#!/bin/sh\\n${trap}\\n' > .hooks/reference-transaction && chmod +x .hooks/reference-transaction && git config core.hooksPath /work/repo/.hooks && echo '*.mjs diff=evil' > .gitattributes && git config diff.evil.textconv '${trap}; cat'`)
  assert.ok(Number(await inBox('wc -c < /work/repo/package-lock.json')) > 500000, 'a lockfile far past the old 80 KB per-file limit')

  // The traps are live: plain Git reading the box's repository runs them.
  const control = await scratch('control')
  await docker(['run', '--rm', '--network', 'none', ...hardened, '--mount', `type=volume,src=${names.volume},dst=/box,readonly`, '--mount', `type=bind,src=${control},dst=/mirror`,
    image, 'sh', '-c', 'git -c safe.directory=* -C /box/repo log -p -1 >/dev/null 2>&1; true'])
  assert.ok(await stat(join(control, 'box-config-ran')), 'an unhardened read of the box runs its config')

  // The review: the commit copied out with no network and the box disk read-only, diffed from the pinned base.
  const reviewMirror = await scratch('review')
  const reviewed = await copy(reviewMirror, sha, baseSha, true)
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed))
  assert.deepEqual(reviewed.review.commits, [{ sha, subject: 'Answer the question' }])
  assert.match(reviewed.review.patch, /-export const answer = 1\n\+export const answer = 42/u)
  assert.match(reviewed.review.patch, /Binary files .*sprite\.png differ/u)
  assert.match(reviewed.review.stat, /3 files changed/u)
  await assert.rejects(stat(join(reviewMirror, 'box-config-ran')), { code: 'ENOENT' }, 'the box’s Git config never ran in the trusted copy')

  // Commits that are not the Task's to publish are refused before anything could be pushed.
  await inBox(`cd /work/repo && git checkout -q --orphan elsewhere && git rm -rqf . && echo other > other.txt && git add other.txt && git commit -qm 'Unrelated history' && git checkout -q work`)
  const unrelated = await inBox('cd /work/repo && git rev-parse elsewhere')
  assert.match((await copy(await scratch('unrelated'), unrelated, baseSha, false)).message, /pinned base/u)
  assert.equal((await copy(await scratch('missing'), 'f'.repeat(40), baseSha, false)).ok, false)

  // The stand-in repository: Git's own HTTP backend behind the Server's receive-pack check for this approval.
  const remote = join(directory, 'remote')
  await mkdir(remote)
  await run('git', ['clone', '-q', '--bare', source, join(remote, 'repo.git')])
  await git(join(remote, 'repo.git'), 'config', 'http.receivepack', 'true')
  // Git serves only a repository its own user owns, so the stand-in runs as whoever made it: on a Linux host
  // a bind mount keeps the host's uid, which need not be the box's 1000.
  await gitServer(names.server, remote, { EXPECTED_REF: ref, EXPECTED_SHA: sha })

  // The approved push: exactly that commit to the Task's branch, while the branch is where this Task left it.
  const pushMirror = await scratch('push')
  assert.equal((await copy(pushMirror, sha, baseSha, false)).ok, true)
  await assert.rejects(stat(join(pushMirror, 'box-config-ran')), { code: 'ENOENT' })
  const moved = await push(pushMirror, sha, 'e'.repeat(40))
  assert.equal(moved.ok, false, 'a branch that moved is never overwritten')
  assert.match(moved.message, /stale info/u, 'a refused push says why')
  assert.equal(moved.message.includes(capability), false)
  const pushed = await push(pushMirror, sha, null)
  assert.deepEqual(pushed, { ok: true }, `${pushed.message}\n${await serverLogs()}`)
  assert.equal(await git(join(remote, 'repo.git'), 'rev-parse', ref), sha)
  assert.equal(await git(join(remote, 'repo.git'), 'rev-parse', 'main'), baseSha)
  assert.equal(await git(join(remote, 'repo.git'), 'show', `${sha}:package-lock.json`).then(text => text.length > 500000), true)

  // Anything else is refused at the receive-pack check, and the branch stays at the approved commit.
  await inBox(`cd /work/repo && echo 'export const answer = 43' > answer.mjs && git commit -qam 'Not approved' && git rev-parse HEAD`)
  const unapproved = await inBox('cd /work/repo && git rev-parse HEAD')
  const otherMirror = await scratch('other')
  assert.equal((await copy(otherMirror, unapproved, baseSha, false)).ok, true)
  const other = await push(otherMirror, unapproved, sha)
  assert.equal(other.ok, false, 'another commit is refused')
  assert.equal(other.message.includes(capability), false)
  assert.equal(await git(join(remote, 'repo.git'), 'rev-parse', ref), sha)
  const refused = (await docker(['logs', names.server])).split('\n').filter(line => line.startsWith('refused'))
  assert.ok(refused.some(line => line.includes('approved commit')), refused.join('\n'))

  // direct_push: the approved commit goes to main only as a fast-forward from the head the Server read.
  await gitServer(names.direct, remote, { EXPECTED_REF: 'refs/heads/main', EXPECTED_SHA: sha, EXPECTED_OLD: baseSha })
  const diverged = await push(pushMirror, sha, 'e'.repeat(40), { server: names.direct, target: 'refs/heads/main', fastForward: true })
  assert.equal(diverged.ok, false)
  assert.match(diverged.message, /only fast-forwards/u, 'a base branch that moved elsewhere is never overwritten')
  assert.equal(await git(join(remote, 'repo.git'), 'rev-parse', 'main'), baseSha)
  const direct = await push(pushMirror, sha, baseSha, { server: names.direct, target: 'refs/heads/main', fastForward: true })
  assert.deepEqual(direct, { ok: true }, `${direct.message}\n${(await run('docker', ['logs', names.direct], { allowFailure: true })).stderr}`)
  assert.equal(await git(join(remote, 'repo.git'), 'rev-parse', 'main'), sha)

  // Nothing the box can read holds a push credential: it reaches the push container only, on stdin.
  assert.equal(await inBox(`grep -rl ${capability} /proc/*/environ /work 2>/dev/null | wc -l`), '0')
  assert.equal(await inBox('id -u; test -e /var/run/docker.sock && echo docker || echo no-docker'), '1000\nno-docker')
  console.log('PASS: real Docker box checkout and control socket, Git work with a large lockfile and a binary file, hardened copy and review with no network from the read-only box disk (box Git config never ran), refusal of foreign and missing commits, force-with-lease push of exactly the approved commit, refusal of any other commit at the receive-pack check, and a direct push to main as a fast-forward only')
} finally {
  for (const container of [names.box, names.server, names.direct]) await docker(['rm', '-f', container], { allowFailure: true })
  await docker(['volume', 'rm', names.volume], { allowFailure: true })
  await rm(directory, { recursive: true, force: true }).catch(async () => {
    // Files the containers wrote as uid 1000 may need a container to remove them.
    await docker(['run', '--rm', '--user', '0:0', '--mount', `type=bind,src=${directory},dst=/d`, image, 'rm', '-rf', '/d/review', '/d/control', '/d/push', '/d/other', '/d/remote', '/d/unrelated', '/d/missing'], { allowFailure: true })
    await rm(directory, { recursive: true, force: true })
  })
}
