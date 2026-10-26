import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:https'
import { codeState } from '../src/cloud-io.mjs'
import { snapshot } from '../src/operate.mjs'

const image = process.env.LLLL_FACTORY_CLOUD_TEST_IMAGE
const inside = process.env.LLLL_CLOUD_STATE_FIXTURE === '1'

test('Cloudflare code checkpoints retain exact history, staged/dirty/untracked source and clean publication commits', { skip: !inside && !image, timeout: 120000 }, async () => {
  if (!inside) {
    const fixtures = await mkdtemp(join(tmpdir(), 'l4-cloud-code-'))
    try {
      await chmod(fixtures, 0o755)
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixtures, 'key.pem'), '-out', join(fixtures, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
      await chmod(join(fixtures, 'key.pem'), 0o644)
      const repository = resolve(import.meta.dirname, '../../..')
      await new Promise((done, reject) => {
        const child = spawn('docker', ['--host=unix:///var/run/docker.sock', 'run', '--rm', '--network', 'none',
          '--env', 'LLLL_CLOUD_STATE_FIXTURE=1', '--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1',
          '--mount', `type=bind,src=${repository},dst=/repo,readonly`,
          '--mount', `type=bind,src=${join(repository, 'packages/compute-node/src')},dst=/opt/l4,readonly`,
          '--mount', `type=bind,src=${fixtures},dst=/fixture,readonly`,
          '--mount', `type=bind,src=${join(fixtures, 'cert.pem')},dst=/etc/cloudflare/certs/cloudflare-containers-ca.crt,readonly`,
          image, 'node', '--test', '/repo/packages/compute-node/test/cloud-state.test.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', chunk => { output += chunk })
        child.stderr.on('data', chunk => { output += chunk })
        child.once('error', reject)
        child.once('close', code => code === 0 ? done() : reject(new Error(output)))
      })
    } finally { await rm(fixtures, { recursive: true, force: true }) }
    return
  }

  const directory = await mkdtemp(join(tmpdir(), 'l4-git-storage-'))
  const source = join(directory, 'source'), repositories = join(directory, 'repositories')
  await mkdir(source); await mkdir(repositories)
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const root = '/workspace/repo'
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Upstream author'); git(source, 'config', 'user.email', 'upstream@example.invalid')
  await writeFile(join(source, 'answer.txt'), 'original\n')
  await writeFile(join(source, 'asset.bin'), Buffer.from([0, 1, 2, 255]))
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Required original history')
  const ancestor = git(source, 'rev-parse', 'HEAD')
  await writeFile(join(source, 'README.md'), 'Original repository\n')
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Pinned upstream base')
  const baseSha = git(source, 'rev-parse', 'HEAD')
  git(directory, 'clone', '--bare', source, join(repositories, 'source.git'))
  git(directory, 'init', '--bare', join(repositories, 'code.git'))
  git(join(repositories, 'code.git'), 'config', 'http.receivepack', 'true')

  const server = createServer({ key: await readFile('/fixture/key.pem'), cert: await readFile('/fixture/cert.pem') }, (request, response) => {
    const url = new URL(request.url, 'https://localhost')
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'fixture', HTTP_GIT_PROTOCOL: request.headers['git-protocol'] ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] })
    request.pipe(child.stdin)
    child.stdin.on('error', () => {})
    child.stderr.resume()
    let headers = Buffer.alloc(0), opened = false
    child.stdout.on('data', chunk => {
      if (opened) { response.write(chunk); return }
      headers = Buffer.concat([headers, chunk])
      const boundary = headers.indexOf('\r\n\r\n')
      if (boundary < 0) return
      let status = 200
      for (const line of headers.subarray(0, boundary).toString().split('\r\n')) {
        const at = line.indexOf(':')
        if (at < 0) continue
        const name = line.slice(0, at), value = line.slice(at + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3))
        else response.setHeader(name, value)
      }
      response.writeHead(status); opened = true
      response.write(headers.subarray(boundary + 4)); headers = Buffer.alloc(0)
    })
    child.once('close', () => { if (!opened) response.writeHead(502); response.end() })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = 'https://127.0.0.1:' + server.address().port
  try {
    assert.equal((await codeState({ operation: 'bootstrap', remote: origin + '/source.git', baseSha })).ok, true)
    assert.equal(git(root, 'rev-parse', 'HEAD'), baseSha)
    assert.equal(git(root, 'rev-parse', 'HEAD~1'), ancestor)
    assert.equal(git(root, 'remote'), '')
    await writeFile(join(root, 'answer.txt'), 'staged\n'); git(root, 'add', 'answer.txt')
    await writeFile(join(root, 'answer.txt'), 'unstaged\n')
    await writeFile(join(root, 'new-source.txt'), 'untracked source\n')
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'cache'), 'disposable dependency cache')
    const first = await codeState({ operation: 'checkpoint', remote: origin + '/code.git', baseSha })
    assert.equal(first.ok, true); assert.equal(first.head, baseSha)
    assert.equal(git(root, 'rev-parse', 'HEAD'), baseSha)
    assert.equal(git(root, 'show', ':answer.txt'), 'staged')
    await rm(root, { recursive: true, force: true })
    await codeState({ operation: 'restore', remote: origin + '/code.git', baseSha, checkpoint: first.checkpoint })
    assert.equal(git(root, 'rev-parse', 'HEAD'), baseSha)
    assert.equal(git(root, 'rev-parse', 'HEAD~1'), ancestor)
    assert.equal(git(root, 'show', ':answer.txt'), 'staged')
    assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), 'unstaged\n')
    assert.equal(await readFile(join(root, 'new-source.txt'), 'utf8'), 'untracked source\n')
    await assert.rejects(readFile(join(root, 'node_modules', 'cache')), { code: 'ENOENT' })
    assert.equal(git(root, 'remote'), '')
    assert.equal(git(root, 'diff', '--cached', '--name-only'), 'answer.txt')
    assert.equal(git(root, 'diff', '--name-only'), 'answer.txt')
    assert.deepEqual(await readFile(join(root, 'asset.bin')), Buffer.from([0, 1, 2, 255]))

    git(root, 'add', '-A'); git(root, 'commit', '-m', 'Reviewed coding change')
    const committedHead = git(root, 'rev-parse', 'HEAD')
    const publication = await snapshot(root, baseSha)
    assert.equal(publication.headSha, committedHead)
    assert.equal(publication.commits.length, 1)
    assert.equal(publication.commits[0].message, 'Reviewed coding change\n')
    assert.equal(publication.commits[0].parents[0], baseSha)
    const second = await codeState({ operation: 'checkpoint', remote: origin + '/code.git', baseSha, checkpoint: first.checkpoint })
    await rm(root, { recursive: true, force: true })
    await codeState({ operation: 'restore', remote: origin + '/code.git', baseSha, checkpoint: second.checkpoint })
    assert.equal(git(root, 'rev-parse', 'HEAD'), committedHead)
    assert.equal(git(root, 'status', '--porcelain'), '')
    assert.deepEqual(await snapshot(root, baseSha), publication)
    assert.equal(git(join(repositories, 'source.git'), 'rev-parse', 'main'), baseSha)
    await rm(root, { recursive: true, force: true })
    await assert.rejects(codeState({ operation: 'restore', remote: origin + '/code.git', baseSha, checkpoint: first.checkpoint }), /Checkpoint differs/u)
  } finally {
    await rm(root, { recursive: true, force: true })
    await new Promise(done => server.close(done))
    await rm(directory, { recursive: true, force: true })
  }
})

test('Cloud image keeps its root idle supervisor alive while checkpoint cleanup kills Task processes', {
  skip: !process.env.LLLL_FACTORY_CLOUD_LIFECYCLE_IMAGE,
  timeout: 30000,
}, async () => {
  const container = 'l4-cloud-lifecycle-' + crypto.randomUUID()
  const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    docker('run', '-d', '--name', container, '--network', 'none', process.env.LLLL_FACTORY_CLOUD_LIFECYCLE_IMAGE)
    const supervisor = docker('exec', '--user', '0:0', container, '/usr/local/bin/node', '-e', "const fs=require('node:fs'); const line=fs.readFileSync('/proc/1/status','utf8').split('\\n').find(line=>line.startsWith('Uid:')); console.log(line)")
    assert.match(supervisor, /^Uid:\s+0\s+0\s+0\s+0$/u)
    docker('exec', '--user', '1000:1000', container, '/bin/sh', '-c', 'sleep 600 >/dev/null 2>&1 &')
    docker('exec', '--user', '0:0', container, '/usr/bin/pkill', '-KILL', '-u', '1000')
    assert.equal(docker('inspect', '--format', '{{.State.Running}}', container), 'true')
    docker('exec', '--user', '1000:1000', container, '/usr/local/bin/node', '-e', "const fs=require('node:fs'); fs.writeFileSync('/workspace/checkpoint-proof','retained source'); if(process.getuid()!==1000)process.exit(1)")
    assert.equal(docker('exec', '--user', '0:0', container, 'cat', '/workspace/checkpoint-proof'), 'retained source')
    assert.equal(docker('inspect', '--format', '{{.State.Running}}', container), 'true')
  } finally { docker('rm', '-f', container) }
})
