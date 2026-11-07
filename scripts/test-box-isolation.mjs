// Real Docker: nothing secret is in the Agent's box (ADR 0011, "Nothing in the box").
//
// The daemon's own box host (packages/compute-node/src/boxes.mjs) starts a box with its egress proxy, as on a
// VPS Node, against a stand-in Server. Canaries are planted where the trusted side holds credentials: the
// Run capability's source (the Server secret that signs capabilities) and a GitHub token in the daemon's
// environment, the GitHub token again in the source grant, and a Project secret's value in the proxy's
// memory. The test then reads everything the box can: its environment, /proc/*/environ and /proc/*/cmdline,
// and its whole filesystem with its mounts, and finds none of them. Docker's own view of the box and the
// proxy has none either. The Project secret still reaches its bound host through the proxy, which takes it
// out of the answer again; an open host without a bound secret stays a plain tunnel; a closed host and the
// network around the proxy stay closed.
//
// A stand-in host on a private address needs a proxy that resolves it there and trusts its authority. Only
// this script gives the proxy that, through an entry point of its own mounted into the proxy's container;
// the image's proxy.mjs always resolves through DNS and refuses private addresses.
//
// Needs Docker and the box image: docker build -t l4-workspace:test -f packages/compute-node/Dockerfile.workspace .
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoxHost } from '../packages/compute-node/src/boxes.mjs'
import { createBoxCa, issueHostCertificate } from '../packages/compute-node/src/box-ca.mjs'

const image = process.env.LLLL_FACTORY_TEST_IMAGE || 'l4-workspace:test'
const canary = label => `l4canary${label}${randomBytes(12).toString('hex')}`
const canaries = { runCapabilitySource: canary('runsource'), githubToken: `ghs_${canary('github')}`, projectSecret: canary('secret') }
// The daemon's environment: what a careless docker argument could forward into a container.
Object.assign(process.env, { AUTH_SECRET: canaries.runCapabilitySource, GITHUB_TOKEN: canaries.githubToken, LLLL_PAIRING_TOKEN: canaries.githubToken })

function run(command, args, { input, allowFailure = false, limit = 64 * 1024 * 1024 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = [], err = []
    let size = 0
    child.stdout.on('data', chunk => { size += chunk.length; if (size > limit) child.kill('SIGKILL'); else out.push(chunk) })
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      const result = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }
      code === 0 || allowFailure ? done(result) : reject(Object.assign(new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.slice(-600)}`), { output: result.stdout.toString() }))
    })
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
try { await run('docker', ['info', '--format', '{{.ServerVersion}}']) } catch { console.log('Docker is unavailable; skipping the box isolation test.'); process.exit(0) }

const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'l4-box-isolation-'))
await chmod(directory, 0o755)
const boxId = randomUUID(), taskId = randomUUID(), lease = 'a'.repeat(64), suffix = boxId.slice(0, 8)
const connection = { nodeId: randomUUID(), serverId: randomUUID() }
const names = { box: `l4-box-${boxId}`, egress: `l4-egress-${boxId}`, upstream: `l4-test-upstream-${suffix}` }
const placeholder = 'L4_SECRET_TELEGRAM_TOKEN'
let host

/** Docker as the daemon calls it, with this test's own proxy entry point in place of the image's. */
async function docker(args, options = {}) {
  let argv = args
  if (args[0] === 'run' && args.includes(names.egress) && args.at(-1) === '/opt/l4/proxy.mjs') {
    argv = [...args.slice(0, -3), '--mount', `type=bind,src=${join(directory, 'entry')},dst=/opt/test,readonly`, image, 'node', '/opt/test/entry.mjs']
  }
  return (await run('docker', argv, options)).stdout.toString()
}
const inBox = async (command, { env = [], input, allowFailure = false } = {}) =>
  (await run('docker', ['exec', ...(input === undefined ? [] : ['-i']), ...env.flatMap(value => ['-e', value]), names.box, 'sh', '-c', command], { input, allowFailure })).stdout.toString()
/** Every canary that occurs in these bytes. */
const found = bytes => Object.entries(canaries).filter(([, value]) => Buffer.from(bytes).includes(value)).map(([name]) => name)

try {
  // The repository the Task is pinned to, as the trusted fetch broker would hand it over.
  const source = join(directory, 'source')
  await mkdir(source)
  const git = (...args) => run('git', ['-C', source, ...args])
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'bot.mjs'), 'export const bot = true\n'); await git('add', '.'); await git('commit', '-qm', 'Bot')
  const baseSha = (await git('rev-parse', 'HEAD')).stdout.toString().trim()
  await git('bundle', 'create', join(directory, 'source.bundle'), '--all')
  await chmod(join(directory, 'source.bundle'), 0o644)

  // The stand-in hosts: one service on the bridge network with certificates for both, from its own authority.
  const upstream = createBoxCa(randomUUID()), service = join(directory, 'service')
  await mkdir(service); await chmod(service, 0o755)
  const certificates = Object.fromEntries(['api.telegram.org', 'registry.npmjs.org'].map(name => [name, issueHostCertificate(upstream, name)]))
  await writeFile(join(service, 'certificates.json'), JSON.stringify(certificates), { mode: 0o644 })
  await writeFile(join(service, 'server.mjs'), `import { createServer } from 'node:https'
import { createSecureContext } from 'node:tls'
import { readFileSync } from 'node:fs'
const certificates = JSON.parse(readFileSync('/service/certificates.json', 'utf8'))
const contexts = Object.fromEntries(Object.entries(certificates).map(([name, pair]) => [name, createSecureContext(pair)]))
createServer({ SNICallback: (name, done) => done(null, contexts[name]) }, (request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk)).on('end', () => {
    const body = Buffer.concat(chunks).toString()
    console.log(JSON.stringify({ host: request.headers.host, url: request.url, authorization: request.headers.authorization ?? null, body }))
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('echo ' + request.url + ' ' + (request.headers.authorization ?? '') + ' ' + body)
  })
}).listen(8443, '0.0.0.0', () => console.log('listening'))
`, { mode: 0o644 })
  await run('docker', ['run', '-d', '--name', names.upstream, '--network', 'bridge', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--mount', `type=bind,src=${service},dst=/service,readonly`, image, 'node', '/service/server.mjs'])
  for (let attempt = 0; attempt < 50 && !(await run('docker', ['logs', names.upstream], { allowFailure: true })).stdout.toString().includes('listening'); attempt++) await new Promise(done => setTimeout(done, 200))
  const upstreamAddress = JSON.parse((await run('docker', ['inspect', names.upstream])).stdout.toString())[0].NetworkSettings.Networks.bridge.IPAddress
  const received = async () => (await run('docker', ['logs', names.upstream])).stdout.toString().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))

  // This test's proxy entry point: the image's proxy, resolving the stand-in hosts to the service.
  const entry = join(directory, 'entry')
  await mkdir(entry); await chmod(entry, 0o755)
  await writeFile(join(entry, 'upstream.pem'), upstream.cert, { mode: 0o644 })
  await writeFile(join(entry, 'entry.mjs'), `import { readFileSync } from 'node:fs'
import { createEgressProxy, serveEgress, POLICY } from '/opt/l4/proxy.mjs'
const address = ${JSON.stringify(upstreamAddress)}
serveEgress(createEgressProxy({ policyPath: POLICY, resolver: async () => [{ address }], isPublic: () => true, upstreamPort: 8443, upstreamCa: readFileSync('/opt/test/upstream.pem', 'utf8') }))
`, { mode: 0o644 })

  // The stand-in Server: one box, with the bot host open and its secret bound to it.
  const egress = { revision: 'r1', hosts: ['api.telegram.org', 'registry.npmjs.org'], secretHosts: ['api.telegram.org'] }
  const poll = async body => {
    if (body.operation === 'sync') return { boxes: [{ id: boxId, lease, want: 'running', taskId, image, diskBytes: 1073741824, cpu: 1, memoryMiB: 1024, egress }] }
    if (body.operation === 'source') return { id: boxId, repository: 'inchidev/bot', baseSha, sourceToken: canaries.githubToken }
    if (body.operation === 'secrets') {
      assert.deepEqual(body, { operation: 'secrets', boxId, lease })
      return { revision: 'r1', known: [{ placeholder, name: 'TELEGRAM_TOKEN', hosts: ['api.telegram.org'] }], secrets: [{ placeholder, hosts: ['api.telegram.org'], value: canaries.projectSecret }] }
    }
    throw new Error('Unexpected operation ' + body.operation)
  }
  const disks = {
    async ensure(id) { const path = join(directory, `disk-${id}`); await mkdir(path, { recursive: true }); await chmod(path, 0o777); return path },
    async remove(id) { await rm(join(directory, `disk-${id}`), { recursive: true, force: true }) },
    async flush() {},
  }
  // The daemon's egress files, as daemon.mjs writes them.
  const egressRoot = join(directory, 'box-egress')
  const publicFile = async (path, content) => { const temporary = `${path}.${randomUUID()}`; await writeFile(temporary, content, { mode: 0o644 }); await chmod(temporary, 0o644); await rename(temporary, path) }
  const egressFiles = {
    async prepare(id) { const base = join(egressRoot, id), files = { policy: join(base, 'policy'), ca: join(base, 'ca') }; for (const path of [base, files.policy, files.ca]) { await mkdir(path, { recursive: true }); await chmod(path, 0o755) } return files },
    writePolicy: (id, policy) => publicFile(join(egressRoot, id, 'policy', 'policy.json'), JSON.stringify(policy)),
    async writeCa(id, cert, bundle) { await publicFile(join(egressRoot, id, 'ca', 'ca.pem'), cert); await publicFile(join(egressRoot, id, 'ca', 'bundle.pem'), bundle) },
    remove: id => rm(join(egressRoot, id), { recursive: true, force: true }),
  }
  const records = new Map()
  const failures = []
  host = createBoxHost({ docker, poll, disks, records: { list: () => [...records.values()], save: record => records.set(record.id, record), forget: id => records.delete(id) },
    fetchSource: async grant => { assert.equal(grant.sourceToken, canaries.githubToken); return { bundle: join(directory, 'source.bundle'), release: async () => {} } },
    connection, image, server: 'https://server.example', capacity: { cpu: 2, memoryMiB: 4096, boxes: 2 }, diskFree: async () => 1e10, egressFiles,
    log: (event, detail) => failures.push({ event, detail }) })
  await host.sync()
  await host.settled()
  assert.equal(host.boxes.get(boxId)?.state, 'idle', `the box started: ${JSON.stringify(failures)}`)

  // The box trusts its own authority and holds no key for it.
  assert.equal((await inBox('ls /run/l4-ca')).trim().split('\n').sort().join(' '), 'bundle.pem ca.pem')
  assert.doesNotMatch(await inBox('cat /run/l4-ca/ca.pem /run/l4-ca/bundle.pem'), /PRIVATE KEY/u)

  // The Project secret reaches its bound host through the proxy, from Node, Python and Git, and its value comes back as the placeholder.
  const fetched = await inBox(`node -e "fetch('https://api.telegram.org/bot${placeholder}/getMe',{method:'POST',headers:{authorization:'Bearer ${placeholder}','content-type':'application/json'},body:JSON.stringify({token:'${placeholder}'})}).then(r=>r.text()).then(t=>console.log(t))"`)
  assert.equal(fetched.trim(), `echo /bot${placeholder}/getMe Bearer ${placeholder} {"token":"${placeholder}"}`)
  const hit = (await received()).at(-1)
  assert.deepEqual(hit, { host: 'api.telegram.org', url: `/bot${canaries.projectSecret}/getMe`, authorization: `Bearer ${canaries.projectSecret}`, body: JSON.stringify({ token: canaries.projectSecret }) })
  const python = await inBox(`python3 -c "import urllib.request; print(urllib.request.urlopen(urllib.request.Request('https://api.telegram.org/py', headers={'Authorization': 'Bearer ${placeholder}'})).read().decode())"`)
  assert.equal(python.trim(), `echo /py Bearer ${placeholder}`)
  assert.equal((await received()).at(-1).authorization, `Bearer ${canaries.projectSecret}`)
  const gitAttempt = await run('docker', ['exec', names.box, 'git', 'ls-remote', 'https://api.telegram.org/repo.git'], { allowFailure: true })
  assert.doesNotMatch(gitAttempt.stderr, /certificate|SSL|TLS/iu, 'Git trusts the box’s authority through GIT_SSL_CAINFO')
  assert.ok((await received()).some(request => request.url === '/repo.git/info/refs?service=git-upload-pack'), 'Git reached the host through the proxy')
  // A token that is no Project placeholder is ordinary text.
  const unknown = await inBox(`node -e "fetch('https://api.telegram.org/x',{headers:{'x-key':'L4_SECRET_OTHER'}}).then(async r=>console.log(r.status))"`)
  assert.equal(unknown.trim(), '200', 'an unknown placeholder is ordinary text')

  // An open host without a bound secret is a plain tunnel: the box sees the host's own certificate and its placeholder goes out unreplaced.
  await inBox('cat > /tmp/upstream.pem', { input: upstream.cert })
  const tunnelled = await inBox(`node -e "fetch('https://registry.npmjs.org/pkg',{headers:{authorization:'Bearer ${placeholder}'}}).then(r=>r.text()).then(t=>console.log(t))"`, { env: ['NODE_EXTRA_CA_CERTS=/tmp/upstream.pem'] })
  assert.match(tunnelled, /^echo \/pkg Bearer L4_SECRET_TELEGRAM_TOKEN/u)
  assert.equal((await received()).at(-1).authorization, `Bearer ${placeholder}`)
  const untrusted = await inBox(`node -e "fetch('https://registry.npmjs.org/pkg').then(()=>console.log('trusted'),e=>console.log('refused',e.cause?.code))"`)
  assert.match(untrusted, /refused/u, 'the proxy never opens a tunnel with the box’s authority')

  // A closed host, and anything around the proxy, stay closed.
  assert.match(await inBox(`node -e "fetch('https://example.com/').then(r=>console.log('open',r.status),e=>console.log('closed'))"`), /closed/u)
  assert.match(await inBox(`node -e "fetch('https://1.1.1.1/').then(r=>console.log('open'),e=>console.log('closed'))"`, { env: ['NODE_USE_ENV_PROXY=0'] }), /closed/u)

  // Nothing secret is readable in the box: its environment, every process's environment and command line, and its whole filesystem.
  assert.deepEqual(found(await inBox('env')), [], 'environment')
  const proc = (await run('docker', ['exec', names.box, 'sh', '-c', 'for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; echo; done'])).stdout
  assert.ok(proc.includes('/opt/agent/src/box.mjs'), 'the box’s own processes were read')
  assert.deepEqual(found(proc), [], '/proc/*/environ and /proc/*/cmdline')
  // A control: what the box writes to its temporary disk is in the scan.
  const marker = `l4marker${randomBytes(8).toString('hex')}`
  await inBox('cat > /tmp/marker', { input: marker })
  const filesystem = (await run('docker', ['exec', names.box, 'tar', '-cf', '-', '--exclude=./proc', '--exclude=./sys', '--exclude=./dev', '-C', '/', '.'], { allowFailure: true, limit: 4 * 1024 * 1024 * 1024 })).stdout
  assert.ok(filesystem.length > 50 * 1024 * 1024 && filesystem.includes('export const bot = true') && filesystem.includes(marker), 'the filesystem, with the Task disk and /tmp, was read')
  assert.deepEqual(found(filesystem), [], 'filesystem')
  // Docker's own view of both containers carries none either: the value went only through the proxy's control socket.
  assert.deepEqual(found((await run('docker', ['inspect', names.box, names.egress])).stdout), [], 'docker inspect')
  assert.deepEqual(found((await run('docker', ['logs', names.egress])).stdout), [], 'proxy logs')
  console.log(JSON.stringify({ ok: true, box: boxId, checked: Object.keys(canaries), filesystemBytes: filesystem.length, upstreamRequests: (await received()).length }))
} finally {
  if (host) { await host.shutdown().catch(() => {}) }
  await run('docker', ['rm', '-f', names.box, names.egress, names.upstream, `l4-checkout-${boxId}`], { allowFailure: true })
  await run('docker', ['network', 'rm', `l4-boxnet-${boxId}`], { allowFailure: true })
  await run('docker', ['volume', 'rm', `l4-disk-${boxId}`], { allowFailure: true })
  await rm(directory, { recursive: true, force: true }).catch(() => {})
}
