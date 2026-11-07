import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoxHost, BOX_IDLE_MS } from '../src/boxes.mjs'

const connection = { nodeId: '00000000-0000-4000-8000-0000000000a1', serverId: '00000000-0000-4000-8000-0000000000b1' }
const image = 'registry.example/l4-box@sha256:' + 'a'.repeat(64)
const boxId = '00000000-0000-4000-8000-0000000000c1', taskId = '00000000-0000-4000-8000-0000000000d1'
const runId = '00000000-0000-4000-8000-0000000000e1', secondRun = '00000000-0000-4000-8000-0000000000e2'
const leaseA = 'a'.repeat(64), leaseB = 'b'.repeat(64)
const token = 'run-capability-only-in-the-box-stdin'
const waitFor = async (check, label = 'condition') => {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(`Timed out waiting for ${label}`)
}
const flag = (args, name) => args.filter((value, index) => args[index - 1] === name)

/** Docker as the host sees it: containers, volumes and networks by name, and each box's control socket. */
function fakeDocker({ health = { status: 'ready', checkout: true } } = {}) {
  const calls = [], containers = new Map(), volumes = new Map(), networks = new Set(), controls = [], turns = [], pushes = [], loads = []
  async function docker(args, options = {}) {
    calls.push(args)
    const [command, sub] = args
    if (command === 'volume' && sub === 'inspect') { const volume = volumes.get(args[2]); if (!volume) throw new Error('No such volume'); return JSON.stringify([volume]) }
    if (command === 'volume' && sub === 'create') {
      const labels = Object.fromEntries(flag(args, '--label').map(label => label.split('=')))
      volumes.set(args.at(-1), { Driver: 'local', Labels: labels, Options: { device: flag(args, '--opt').find(value => value.startsWith('device=')).slice(7) } })
      return args.at(-1)
    }
    if (command === 'volume' && sub === 'rm') { volumes.delete(args[2]); return '' }
    if (command === 'network' && sub === 'create') { networks.add(args.at(-1)); return '' }
    if (command === 'network' && sub === 'rm') { if (!networks.delete(args[2])) throw new Error('No such network'); return '' }
    if (command === 'network' && sub === 'connect') return ''
    if (command === 'rm') { if (!containers.delete(args[2])) throw new Error('No such container'); return '' }
    if (command === 'inspect') return JSON.stringify([{ NetworkSettings: { Networks: { [`l4-boxnet-${boxId}`]: { IPAddress: '172.30.0.2' } } } }])
    if (command === 'run') {
      const name = flag(args, '--name')[0]
      if (sub === '-d') { containers.set(name, args); return 'container\n' }
      if (args.at(-1) === '/opt/l4/review-diff.mjs') {
        const request = JSON.parse(options.input)
        return JSON.stringify(request.review ? { ok: true, review: { sha: request.sha, baseSha: request.baseSha, commits: [], stat: '', patch: '+change', truncated: false } } : { ok: true, sha: request.sha }) + '\n'
      }
      if (args.at(-1) === '/opt/l4/push-branch.mjs') { pushes.push(JSON.parse(options.input)); return JSON.stringify({ ok: true }) + '\n' }
      if (args.at(-1) === '/etc/ssl/certs/ca-certificates.crt') return '-----BEGIN CERTIFICATE-----\nsystem\n-----END CERTIFICATE-----\n'
      return JSON.stringify({ ok: true })
    }
    if (command === 'exec') {
      if (!containers.has(args[2])) throw new Error('No such container')
      const request = JSON.parse(options.input)
      if (args.at(-1) === 'load') { loads.push(request); return '{"ok":true}\n' }
      controls.push(request)
      if (request.op === 'health') return JSON.stringify(health) + '\n'
      if (request.op === 'cancel') { turns.find(turn => turn.submission.runId === request.runId)?.end({ done: true, ok: true, result: 'error' }); return '{"ok":true}\n' }
      let end
      const done = new Promise(resolve => { end = resolve })
      turns.push({ submission: request.submission, end })
      return '{"accepted":true}\n' + JSON.stringify(await done) + '\n'
    }
    throw new Error('Unexpected docker ' + args.join(' '))
  }
  return { docker, calls, containers, volumes, networks, controls, turns, pushes, loads, runs: () => calls.filter(args => args[0] === 'run' && args.at(-1) !== '/etc/ssl/certs/ca-certificates.crt') }
}

/** The Server's side of the Node protocol: each sync gets the answer the test sets. */
function fakeServer() {
  const syncs = [], sources = [], turnRequests = [], events = [], publications = [], secretPolls = []
  let answer = () => [], grant = body => ({ approvalId: body.approvalId, repository: 'inchidev/afterprompt', ref: `refs/heads/l4-agent/${boxId}`, sha: 'd'.repeat(40), baseSha: 'c'.repeat(40), expectedOld: null,
    remote: 'https://github.com/inchidev/afterprompt.git', token: 'ghs_single_repository_push' })
  const submission = id => ({ runId: id, sessionId: id, prompt: 'Ship it', computer: true, box: true, timeoutMs: 60000,
    modelGateway: { url: `https://server.example/api/agent-runs/${id}/gateway/v1`, token, model: 'm' }, toolEndpoint: `https://server.example/api/agent-runs/${id}/gateway/tools` })
  const poll = async body => {
    if (body.operation === 'sync') { syncs.push(body); return { boxes: answer(body) } }
    if (body.operation === 'source') { sources.push(body); return { id: body.boxId, repository: 'inchidev/afterprompt', baseSha: 'c'.repeat(40), sourceToken: 'ghs_read' } }
    if (body.operation === 'turn') { turnRequests.push(body); return { submission: submission(body.runId) } }
    if (body.operation === 'publish') { publications.push(body); return grant(body) }
    if (body.operation === 'published') { publications.push(body); return { accepted: true } }
    if (body.operation === 'secrets') { secretPolls.push(body); return { revision: 'r2', known: [{ placeholder: 'L4_SECRET_TOKEN', name: 'TOKEN', hosts: ['api.telegram.org'] }], secrets: [{ placeholder: 'L4_SECRET_TOKEN', hosts: ['api.telegram.org'], value: 'only-in-proxy-memory' }] } }
    throw new Error('Unexpected operation')
  }
  const fetcher = async (url, init) => { events.push({ url, authorization: init.headers.Authorization, body: JSON.parse(init.body) }); return Response.json({ ack: 0, cancel: false, steer: [] }) }
  return { poll, fetcher, syncs, sources, turnRequests, events, publications, secretPolls, set answer(value) { answer = value }, set grant(value) { grant = value } }
}
const want = (overrides = {}) => ({ id: boxId, lease: leaseA, want: 'running', taskId, image, diskBytes: 10737418240, cpu: 1, memoryMiB: 4096,
  egress: { revision: 'r1', hosts: ['registry.npmjs.org'], secretHosts: [] }, ...overrides })

function host({ docker, server, saved = [], clock = { now: 1_000_000 }, disks, publisher = {} } = {}) {
  const records = new Map(saved.map(record => [record.id, record]))
  const store = { list: () => [...records.values()], save: record => records.set(record.id, { ...record }), forget: id => records.delete(id) }
  const fetched = [], released = []
  disks ??= { ensured: [], removed: [], flushed: [],
    async ensure(id, create, bytes) { this.ensured.push({ id, create, bytes }); return `/state/box-disks/${id}` },
    async remove(id) { this.removed.push(id) }, async flush(path) { this.flushed.push(path) } }
  const egress = { policies: [], cas: [], removed: [],
    async prepare(id) { return { policy: `/state/box-egress/${id}/policy`, ca: `/state/box-egress/${id}/ca` } },
    async writePolicy(id, policy) { this.policies.push({ id, policy }) }, async writeCa(id, cert, bundle) { this.cas.push({ id, cert, bundle }) }, async remove(id) { this.removed.push(id) } }
  const boxes = createBoxHost({ docker: docker.docker, poll: server.poll, fetcher: server.fetcher, disks, records: store, connection, image, server: 'https://server.example', egressFiles: egress,
    capacity: { cpu: 4, memoryMiB: 16384, boxes: 4 }, diskFree: async () => 5e10, now: () => clock.now, ...publisher,
    fetchSource: async grant => { fetched.push(grant); return { bundle: '/state/source-disks/bundle', release: async () => { released.push(grant.id) } } } })
  return { boxes, records, disks, fetched, released, clock, egress }
}

test('a box starts on the Server’s word: disk, checkout, closed network, then its turn through docker exec', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want({ turn: { runId } })]
  await h.boxes.sync()
  await h.boxes.settled()
  await waitFor(() => docker.turns.length === 1, 'the turn')
  // The Task disk is made once and bound to its volume; the source comes through the trusted broker.
  assert.deepEqual(h.disks.ensured, [{ id: boxId, create: true, bytes: 10737418240 }])
  assert.equal(docker.volumes.get(`l4-disk-${boxId}`).Options.device, `/state/box-disks/${boxId}`)
  assert.deepEqual(server.sources, [{ operation: 'source', boxId, lease: leaseA }])
  assert.deepEqual(h.released, [boxId])
  const [checkout, egress, box] = docker.runs()
  assert.equal(flag(checkout, '--network')[0], 'none')
  assert.ok(checkout.includes(`type=bind,src=/state/source-disks/bundle,dst=/bootstrap/source.bundle,readonly`))
  assert.deepEqual(checkout.slice(-3), [image, 'node', '/opt/agent/src/checkout.mjs'])
  // The proxy reaches this Server and the hosts the Server allows; the box reaches only the proxy.
  assert.ok(docker.calls.some(args => args[0] === 'network' && args[1] === 'create' && args.includes('--internal') && args.at(-1) === `l4-boxnet-${boxId}`))
  assert.deepEqual(h.egress.policies.at(-1), { id: boxId, policy: { revision: 'r1', hosts: ['server.example', 'registry.npmjs.org'], secretHosts: [] } })
  assert.ok(egress.includes(`type=bind,src=/state/box-egress/${boxId}/policy,dst=/run/l4-policy,readonly`))
  // The box trusts its own authority, never holds its key; the proxy got the key by docker exec.
  assert.ok(box.includes(`type=bind,src=/state/box-egress/${boxId}/ca,dst=/run/l4-ca,readonly`))
  assert.ok(flag(box, '--env').includes('NODE_EXTRA_CA_CERTS=/run/l4-ca/ca.pem') && flag(box, '--env').includes('GIT_SSL_CAINFO=/run/l4-ca/bundle.pem'))
  assert.match(h.egress.cas[0].bundle, /BEGIN CERTIFICATE/u)
  assert.ok(!h.egress.cas[0].cert.includes('PRIVATE KEY') && !box.join(' ').includes('PRIVATE KEY'))
  assert.match(docker.loads[0].ca.key, /PRIVATE KEY/u)
  assert.equal(flag(box, '--network')[0], `l4-boxnet-${boxId}`)
  assert.ok(flag(box, '--env').includes('HTTPS_PROXY=http://172.30.0.2:8080'))
  // The box keeps the rules of the per-operation container, with its reservation as limits.
  for (const [name, value] of [['--user', '1000:1000'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--cpus', '1'], ['--memory', '4096m'], ['--pids-limit', '512'], ['--dns', '127.0.0.1']]) assert.deepEqual(flag(box, name), [value], name)
  assert.ok(box.includes('--read-only') && box.includes('--init'))
  assert.ok(box.includes(`type=volume,src=l4-disk-${boxId},dst=/work`))
  assert.ok(!docker.calls.flat().some(value => value.includes('docker.sock') || value.includes(token) || value.includes('ghs_read')))
  assert.deepEqual(box.slice(-3), [image, 'node', '/opt/agent/src/box.mjs'])
  // The turn's submission, with the Run's capability, reaches the box only on stdin.
  assert.deepEqual(server.turnRequests, [{ operation: 'turn', boxId, lease: leaseA, runId }])
  assert.equal(docker.turns[0].submission.modelGateway.token, token)
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'running', runId, runtimeMs: 0 }])
  assert.deepEqual(server.syncs.at(-1).capacity, { cpu: 4, memoryMiB: 16384, boxes: 4, diskFree: 5e10 })
  h.clock.now += 4000
  docker.turns[0].end({ done: true, ok: true, result: 'result' })
  await waitFor(() => h.boxes.boxes.get(boxId).state === 'idle', 'the turn to end')
  // The Run may still be running while it takes the result: the same turn never starts twice.
  await h.boxes.sync()
  assert.equal(docker.turns.length, 1)
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'idle', runtimeMs: 4000 }])
  assert.deepEqual(h.records.get(boxId), { id: boxId, lease: leaseA, taskId, ready: true, runtimeMs: 0 })
})

test('an idle box stops after fifteen minutes and starts again on its disk without a new checkout', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want()]
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'idle')
  h.clock.now += BOX_IDLE_MS - 1
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'idle')
  h.clock.now += 1
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'stopped')
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.networks.size, 0)
  assert.deepEqual(h.disks.flushed, [`/state/box-disks/${boxId}`])
  // The disk stays; the stop is reported with the time the box ran.
  assert.ok(docker.volumes.has(`l4-disk-${boxId}`))
  server.answer = () => [want({ want: 'stopped' })]
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'stopped', runtimeMs: BOX_IDLE_MS }])
  assert.equal(h.records.get(boxId).runtimeMs, BOX_IDLE_MS)
  // A new turn on a later lease starts the same disk again.
  server.answer = () => [want({ lease: leaseB, turn: { runId: secondRun } })]
  await h.boxes.sync()
  await h.boxes.settled()
  await waitFor(() => docker.turns.length === 1, 'the second turn')
  assert.equal(server.sources.length, 1)
  assert.equal(docker.runs().filter(args => flag(args, '--name')[0].startsWith('l4-checkout-')).length, 1)
  assert.deepEqual(h.disks.ensured.map(disk => disk.create), [true, false])
  assert.deepEqual(server.turnRequests.at(-1), { operation: 'turn', boxId, lease: leaseB, runId: secondRun })
  docker.turns[0].end({ done: true, ok: true, result: 'result' })
})

test('a released box goes with its disk and is no longer reported', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want()]
  await h.boxes.sync()
  await h.boxes.settled()
  server.answer = () => [want({ want: 'released' })]
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.volumes.size, 0)
  assert.deepEqual(h.disks.removed, [boxId])
  assert.equal(h.records.size, 0)
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [])
})

test('a Node takes over the lease the Server gives its box, and a restarted daemon starts it from its record', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want()]
  await h.boxes.sync()
  await h.boxes.settled()
  const started = docker.runs().length
  server.answer = () => [want({ lease: leaseB })]
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(docker.runs().length, started)
  assert.equal(h.records.get(boxId).lease, leaseB)
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes.map(box => [box.lease, box.state]), [[leaseB, 'idle']])

  // After a restart the daemon removed every container; the box is reported stopped under its old lease.
  const restarted = fakeDocker(), again = fakeServer()
  restarted.volumes.set(`l4-disk-${boxId}`, docker.volumes.get(`l4-disk-${boxId}`))
  const next = host({ docker: restarted, server: again, saved: [...h.records.values()] })
  again.answer = body => body.boxes.map(box => want({ id: box.id, lease: 'd'.repeat(64) }))
  await next.boxes.sync()
  assert.deepEqual(again.syncs[0].boxes, [{ id: boxId, lease: leaseB, state: 'stopped', runtimeMs: 0 }])
  await next.boxes.settled()
  assert.equal(next.boxes.boxes.get(boxId).state, 'idle')
  assert.deepEqual(again.sources, [])
  assert.equal(next.records.get(boxId).lease, 'd'.repeat(64))
})

test('a cancelled turn is stopped in the box, and the box stays for the next one', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want({ turn: { runId } })]
  await h.boxes.sync()
  await h.boxes.settled()
  await waitFor(() => docker.turns.length === 1, 'the turn')
  server.answer = body => [want({ cancelRunId: body.boxes[0].runId })]
  await h.boxes.sync()
  await waitFor(() => h.boxes.boxes.get(boxId).state === 'idle', 'the cancelled turn to end')
  assert.deepEqual(docker.controls.filter(request => request.op === 'cancel'), [{ op: 'cancel', runId }])
  assert.equal(docker.containers.size, 2)
})

test('a box that cannot start fails its turn in the conversation instead of leaving it waiting', async () => {
  const docker = fakeDocker({ health: { status: 'ready', checkout: false } }), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want({ turn: { runId } })]
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'failed')
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.turns.length, 0)
  assert.deepEqual(server.events, [{ url: `https://server.example/api/agent-runs/${runId}/gateway/events`, authorization: `Bearer ${token}`,
    body: { from: 0, events: [], result: { type: 'error', message: 'The Agent’s box could not start on its Compute Node. Check the Node’s disk, source access and Docker, then ask again.' } } }])
  await h.boxes.sync()
  assert.equal(server.syncs.at(-1).boxes[0].state, 'failed')
})

test('a volume another Node or Task labelled is never mounted', async () => {
  const docker = fakeDocker(), server = fakeServer()
  docker.volumes.set(`l4-disk-${boxId}`, { Driver: 'local', Labels: { 'l4.node': connection.nodeId, 'l4.server': connection.serverId, 'l4.box': boxId, 'l4.task': '00000000-0000-4000-8000-0000000000ff' }, Options: { device: `/state/box-disks/${boxId}` } })
  const h = host({ docker, server })
  server.answer = () => [want()]
  await h.boxes.sync()
  await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'failed')
  assert.deepEqual(h.disks.ensured, [])
  assert.equal(docker.runs().length, 0)
})

/** The scratch disk, the review upload and the token revocation a daemon gives the host. */
function publisher() {
  const scratched = [], removed = [], uploads = [], revoked = []
  return { scratched, removed, uploads, revoked, options: {
    scratch: { ensure: async id => { scratched.push(id); return `/state/publish-disks/${id}` }, remove: async id => { removed.push(id) } },
    upload: async (approvalId, body) => { uploads.push({ approvalId, body }) }, revoke: async token => { revoked.push(token) } } }
}
const approvalId = '00000000-0000-4000-8000-0000000000f1', pushed = 'd'.repeat(40), base = 'c'.repeat(40)

test('a review copies the commit out of the read-only box disk with no network and hands its diff to the Server', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want()]
  await h.boxes.sync(); await h.boxes.settled()
  server.answer = () => [want({ review: { approvalId, sha: pushed, baseSha: base } })]
  await h.boxes.sync(); await h.boxes.sync(); await h.boxes.settled()
  const copies = docker.runs().filter(args => args.at(-1) === '/opt/l4/review-diff.mjs')
  assert.equal(copies.length, 1, 'one review per approval while it runs')
  const [copy] = copies
  assert.equal(flag(copy, '--network')[0], 'none')
  for (const [name, value] of [['--user', '1000:1000'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges']]) assert.deepEqual(flag(copy, name), [value], name)
  assert.ok(copy.includes('--read-only'))
  assert.ok(copy.includes(`type=volume,src=l4-disk-${boxId},dst=/box,readonly`))
  assert.ok(copy.includes(`type=bind,src=/state/publish-disks/${p.scratched[0]},dst=/mirror`))
  assert.deepEqual(p.uploads, [{ approvalId, body: { ok: true, review: { sha: pushed, baseSha: base, commits: [], stat: '', patch: '+change', truncated: false } } }])
  assert.deepEqual(p.removed, p.scratched)
  assert.deepEqual(server.publications, [])
})

test('an approved push takes its grant, pushes exactly that commit from the copy, revokes the token and reports back', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want()]
  await h.boxes.sync(); await h.boxes.settled()
  server.answer = () => [want({ publish: { approvalId, sha: pushed, ref: `refs/heads/l4-agent/${boxId}`, baseSha: base } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.deepEqual(server.publications, [{ operation: 'publish', approvalId }, { operation: 'published', approvalId, ok: true }])
  const copy = docker.runs().find(args => args.at(-1) === '/opt/l4/review-diff.mjs'), push = docker.runs().find(args => args.at(-1) === '/opt/l4/push-branch.mjs')
  assert.equal(flag(copy, '--network')[0], 'none')
  assert.ok(!copy.join(' ').includes('ghs_single_repository_push'))
  // The push container has the network and the copy, never the box's disk.
  assert.equal(flag(push, '--network')[0], 'bridge')
  assert.ok(!push.some(value => value.includes(`l4-disk-${boxId}`)))
  assert.deepEqual(docker.pushes, [{ remote: 'https://github.com/inchidev/afterprompt.git', ref: `refs/heads/l4-agent/${boxId}`, sha: pushed, expectedOld: null, token: 'ghs_single_repository_push' }])
  assert.ok(!docker.calls.flat().some(value => value.includes('ghs_single_repository_push')), 'the token goes on stdin only')
  assert.deepEqual(p.revoked, ['ghs_single_repository_push'])
  assert.deepEqual(p.removed, p.scratched)
})

test('a push the Server grants for another commit or ref is not made', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want()]
  await h.boxes.sync(); await h.boxes.settled()
  server.grant = body => ({ approvalId: body.approvalId, ref: `refs/heads/l4-agent/${boxId}`, sha: 'e'.repeat(40), remote: 'https://github.com/inchidev/afterprompt.git', token: 'ghs_other' })
  server.answer = () => [want({ publish: { approvalId, sha: pushed, ref: `refs/heads/l4-agent/${boxId}`, baseSha: base } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.deepEqual(docker.pushes, [])
  assert.deepEqual(server.publications.at(-1), { operation: 'published', approvalId, ok: false, message: 'The Server granted another push' })
  assert.deepEqual(p.revoked, ['ghs_other'])
  // A ref other than a box's own branch is ignored before anything runs.
  server.answer = () => [want({ publish: { approvalId: '00000000-0000-4000-8000-0000000000f2', sha: pushed, ref: 'refs/heads/main', baseSha: base } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(server.publications.filter(entry => entry.operation === 'publish').length, 1)
})

test('a new egress revision reloads the proxy’s secrets by docker exec, then rewrites its policy file', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const h = host({ docker, server })
  server.answer = () => [want()]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(server.secretPolls.length, 0, 'no bound host, no values')
  const egress = { revision: 'r2', hosts: ['registry.npmjs.org', 'api.telegram.org'], secretHosts: ['api.telegram.org'] }
  server.answer = () => [want({ egress })]
  await h.boxes.sync(); await h.boxes.settled()
  await h.boxes.sync(); await h.boxes.settled()
  assert.deepEqual(server.secretPolls, [{ operation: 'secrets', boxId, lease: leaseA }])
  assert.deepEqual(docker.loads.at(-1).secrets, [{ placeholder: 'L4_SECRET_TOKEN', hosts: ['api.telegram.org'], value: 'only-in-proxy-memory' }])
  assert.deepEqual(h.egress.policies.at(-1).policy, { revision: 'r2', hosts: ['server.example', 'registry.npmjs.org', 'api.telegram.org'], secretHosts: ['api.telegram.org'] })
  // The value went only through the exec's stdin: no docker argument and no file carries it.
  assert.ok(!docker.calls.flat().some(value => value.includes('only-in-proxy-memory')))
  assert.ok(!JSON.stringify(h.egress.policies).includes('only-in-proxy-memory') && !JSON.stringify(h.egress.cas).includes('only-in-proxy-memory'))
})
