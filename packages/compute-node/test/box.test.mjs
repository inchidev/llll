import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoxHost, BOX_IDLE_MS, RESTORE_FAILED } from '../src/boxes.mjs'

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
function fakeDocker({ health = { status: 'ready', checkout: true }, checkpoints = {} } = {}) {
  const calls = [], containers = new Map(), volumes = new Map(), networks = new Set(), controls = [], turns = [], pushes = [], loads = [], saves = []
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
      if (args.at(-1) === '/opt/l4/checkpoint.mjs') {
        // What the box's containers were when the step ran: a save never runs beside the box.
        const request = JSON.parse(options.input), step = { ...request, running: [...containers.keys()] }
        saves.push(step)
        const answer = checkpoints[request.operation] ?? (request.operation === 'save' ? { ok: true, checkpoint: 'e'.repeat(40), head: 'd'.repeat(40) } : { ok: true })
        if (!answer.ok) throw Object.assign(new Error('Docker operation failed'), { output: JSON.stringify(answer) + '\n' })
        return JSON.stringify(answer) + '\n'
      }
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
  return { docker, calls, containers, volumes, networks, controls, turns, pushes, loads, saves, runs: () => calls.filter(args => args[0] === 'run' && args.at(-1) !== '/etc/ssl/certs/ca-certificates.crt') }
}

/** The Server's side of the Node protocol: each sync gets the answer the test sets. */
function fakeServer() {
  const syncs = [], sources = [], turnRequests = [], events = [], publications = [], secretPolls = [], checkpoints = []
  let source = body => ({ id: body.boxId, repository: 'inchidev/afterprompt', baseSha: 'c'.repeat(40), sourceToken: 'ghs_read' })
  let answer = () => [], grant = body => ({ approvalId: body.approvalId, repository: 'inchidev/afterprompt', ref: `refs/heads/l4-agent/${boxId}`, sha: 'd'.repeat(40), baseSha: 'c'.repeat(40), expectedOld: null,
    remote: 'https://github.com/inchidev/afterprompt.git', token: 'ghs_single_repository_push' })
  const submission = id => ({ runId: id, sessionId: id, prompt: 'Ship it', computer: true, box: true, timeoutMs: 60000,
    modelGateway: { url: `https://server.example/api/agent-runs/${id}/gateway/v1`, token, model: 'm' }, toolEndpoint: `https://server.example/api/agent-runs/${id}/gateway/tools` })
  const poll = async body => {
    if (body.operation === 'sync') { syncs.push(body); return { boxes: answer(body) } }
    if (body.operation === 'source') { sources.push(body); return source(body) }
    if (body.operation === 'checkpoint') { checkpoints.push(body); return { remote: `https://server.example/api/compute-agent/checkpoint/${body.boxId}.git`, authorization: `Bearer ${'9'.repeat(64)}`, baseSha: 'c'.repeat(40), previous: null } }
    if (body.operation === 'checkpointed') { checkpoints.push(body); return { ok: true } }
    if (body.operation === 'turn') { turnRequests.push(body); return { submission: submission(body.runId) } }
    if (body.operation === 'publish') { publications.push(body); return grant(body) }
    if (body.operation === 'published') { publications.push(body); return { accepted: true } }
    if (body.operation === 'secrets') { secretPolls.push(body); return { revision: 'r2', known: [{ placeholder: 'L4_SECRET_TOKEN', name: 'TOKEN', hosts: ['api.telegram.org'] }], secrets: [{ placeholder: 'L4_SECRET_TOKEN', hosts: ['api.telegram.org'], value: 'only-in-proxy-memory' }] } }
    throw new Error('Unexpected operation')
  }
  const fetcher = async (url, init) => { events.push({ url, authorization: init.headers.Authorization, body: JSON.parse(init.body) }); return Response.json({ ack: 0, cancel: false, steer: [] }) }
  return { poll, fetcher, syncs, sources, turnRequests, events, publications, secretPolls, checkpoints, set answer(value) { answer = value }, set grant(value) { grant = value }, set source(value) { source = value } }
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

test('pushes the Project’s prefixed branch, and under direct_push the base branch as a fast-forward only', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want()]
  await h.boxes.sync(); await h.boxes.settled()
  const prefixed = `refs/heads/agents/${boxId}`
  server.grant = body => ({ approvalId: body.approvalId, ref: prefixed, sha: pushed, expectedOld: null, remote: 'https://github.com/inchidev/afterprompt.git', token: 'ghs_a' })
  server.answer = () => [want({ publish: { approvalId, sha: pushed, ref: prefixed, baseSha: base } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.deepEqual(docker.pushes.at(-1), { remote: 'https://github.com/inchidev/afterprompt.git', ref: prefixed, sha: pushed, expectedOld: null, token: 'ghs_a' })
  // Another box's branch under the same prefix is not this box's to push.
  server.answer = () => [want({ publish: { approvalId: '00000000-0000-4000-8000-0000000000f3', sha: pushed, ref: 'refs/heads/agents/00000000-0000-4000-8000-0000000000ff', baseSha: base } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(docker.pushes.length, 1)
  // direct_push: the base branch, with the head it replaces and the fast-forward check.
  const direct = '00000000-0000-4000-8000-0000000000f4'
  server.grant = body => ({ approvalId: body.approvalId, ref: 'refs/heads/main', sha: pushed, expectedOld: base, direct: true, remote: 'https://github.com/inchidev/afterprompt.git', token: 'ghs_b' })
  server.answer = () => [want({ publish: { approvalId: direct, sha: pushed, ref: 'refs/heads/main', baseSha: base, direct: true } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.deepEqual(docker.pushes.at(-1), { remote: 'https://github.com/inchidev/afterprompt.git', ref: 'refs/heads/main', sha: pushed, expectedOld: base, fastForward: true, token: 'ghs_b' })
  // A grant that does not say direct for a direct push, or the other way round, is not made.
  const mismatch = '00000000-0000-4000-8000-0000000000f5'
  server.grant = body => ({ approvalId: body.approvalId, ref: 'refs/heads/main', sha: pushed, expectedOld: base, remote: 'https://github.com/inchidev/afterprompt.git', token: 'ghs_c' })
  server.answer = () => [want({ publish: { approvalId: mismatch, sha: pushed, ref: 'refs/heads/main', baseSha: base, direct: true } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(docker.pushes.length, 2)
  assert.deepEqual(server.publications.at(-1), { operation: 'published', approvalId: mismatch, ok: false, message: 'The Server granted another push' })
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

test('a refused turn says why in the box’s own words only when they are short and plain', async () => {
  const { refusal } = await import('../src/boxes.mjs')
  assert.equal(refusal('Not a turn this box takes (tools: too_big)'), 'The Agent’s box refused this turn (Not a turn this box takes (tools: too_big)). Ask again.')
  assert.equal(refusal('<script>alert(1)</script>'), 'The Agent’s box refused this turn. Ask again.')
  assert.equal(refusal(undefined), 'The Agent’s box refused this turn. Ask again.')
})

test('an idle box on L4 Compute is saved to its checkpoint before it stops, and says so, so its machine can go', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want({ checkpoint: true })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'idle')
  h.clock.now += BOX_IDLE_MS
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'stopped')
  // The grant and the acknowledgement go under the box's lease, which it kept while it was saved.
  const checkpoint = 'e'.repeat(40), headSha = 'd'.repeat(40)
  assert.deepEqual(server.checkpoints, [{ operation: 'checkpoint', boxId, lease: leaseA }, { operation: 'checkpointed', boxId, lease: leaseA, checkpoint, head: headSha }])
  const [save, push] = docker.runs().filter(args => args.at(-1) === '/opt/l4/checkpoint.mjs')
  // The save: no network, the box's disk and the scratch disk, after the box itself stopped.
  assert.equal(flag(save, '--network')[0], 'none')
  assert.ok(save.includes(`type=volume,src=l4-disk-${boxId},dst=/work`))
  assert.ok(save.includes(`type=bind,src=/state/publish-disks/${p.scratched[0]},dst=/mirror`))
  for (const [name, value] of [['--user', '1000:1000'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges']]) assert.deepEqual(flag(save, name), [value], name)
  assert.ok(save.includes('--read-only'))
  assert.deepEqual(docker.saves[0], { operation: 'save', baseSha: 'c'.repeat(40), previous: null, running: [] })
  // The push: the network and the copy only, the capability on stdin.
  assert.equal(flag(push, '--network')[0], 'bridge')
  assert.ok(!push.some(value => value.includes(`l4-disk-${boxId}`)))
  assert.deepEqual(docker.saves[1], { operation: 'push', remote: `https://server.example/api/compute-agent/checkpoint/${boxId}.git`, authorization: `Bearer ${'9'.repeat(64)}`, sha: checkpoint, running: [] })
  assert.ok(!docker.calls.flat().some(value => value.includes('9'.repeat(64))), 'the capability goes on stdin only')
  assert.deepEqual(p.removed, p.scratched)
  // Stopped, at that checkpoint: the Server may let the machine go.
  server.answer = () => [want({ want: 'stopped', checkpoint: true })]
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'stopped', runtimeMs: BOX_IDLE_MS, saved: checkpoint }])
  // It did not: a new turn starts the box on its disk again, which is then no longer that checkpoint.
  server.answer = () => [want({ lease: leaseB, turn: { runId }, checkpoint: true })]
  await h.boxes.sync(); await h.boxes.settled()
  await waitFor(() => docker.turns.length === 1, 'the turn')
  assert.equal(server.sources.length, 1)
  await h.boxes.sync()
  assert.ok(!('saved' in server.syncs.at(-1).boxes[0]))
  docker.turns[0].end({ done: true, ok: true, result: 'result' })
})

test('a box whose save fails only stops, and never says it was saved', async () => {
  const docker = fakeDocker({ checkpoints: { push: { ok: false } } }), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want({ checkpoint: true })]
  await h.boxes.sync(); await h.boxes.settled()
  h.clock.now += BOX_IDLE_MS
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'stopped')
  assert.deepEqual(server.checkpoints.map(body => body.operation), ['checkpoint'])
  assert.ok(docker.volumes.has(`l4-disk-${boxId}`))
  assert.deepEqual(p.removed, p.scratched)
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'stopped', runtimeMs: BOX_IDLE_MS }])
})

test('a Node not told to save its boxes stops them as before, and says nothing of checkpoints', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const h = host({ docker, server, publisher: p.options })
  server.answer = () => [want()]
  await h.boxes.sync(); await h.boxes.settled()
  h.clock.now += BOX_IDLE_MS
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'stopped')
  assert.deepEqual(server.checkpoints, [])
  assert.deepEqual(docker.saves, [])
})

test('a box on a new machine is restored from its checkpoint, and one that cannot be fails its turn instead of starting over', async () => {
  const checkpoint = 'e'.repeat(40)
  for (const restore of [{ ok: true }, { ok: false }]) {
    const docker = fakeDocker({ checkpoints: { restore } }), server = fakeServer()
    const h = host({ docker, server })
    server.source = body => ({ id: body.boxId, repository: 'inchidev/afterprompt', baseSha: 'c'.repeat(40), checkpoint,
      source: { remote: `https://server.example/api/compute-agent/checkpoint/${body.boxId}.git`, authorization: `Bearer ${'9'.repeat(64)}` } })
    server.answer = () => [want({ turn: { runId }, checkpoint: true })]
    await h.boxes.sync(); await h.boxes.settled()
    // The checkpoint is what is fetched, through the Server's checkpoint address, and restored with no network.
    assert.equal(h.fetched[0].baseSha, checkpoint)
    assert.equal(h.fetched[0].source.remote, `https://server.example/api/compute-agent/checkpoint/${boxId}.git`)
    const restored = docker.runs().find(args => args.at(-1) === '/opt/l4/checkpoint.mjs')
    assert.equal(flag(restored, '--network')[0], 'none')
    assert.ok(restored.includes('type=bind,src=/state/source-disks/bundle,dst=/bootstrap/source.bundle,readonly'))
    assert.deepEqual(docker.saves[0], { operation: 'restore', checkpoint, baseSha: 'c'.repeat(40), running: [] })
    assert.ok(!docker.runs().some(args => args.at(-1) === '/opt/agent/src/checkout.mjs'), 'never the pinned source')
    assert.deepEqual(h.released, [boxId])
    if (restore.ok) {
      await waitFor(() => docker.turns.length === 1, 'the turn')
      docker.turns[0].end({ done: true, ok: true, result: 'result' })
    } else {
      assert.equal(h.boxes.boxes.get(boxId).state, 'failed')
      assert.deepEqual(server.events.map(event => event.body.result.message), [RESTORE_FAILED])
    }
  }
})

/** A Node with a preview gate (L4 Compute): the viewers' directories, and docker's options per container it runs. */
function previewHost(docker, server, clock = { now: 1_000_000 }, extra = {}) {
  const options = new Map()
  const recording = { ...docker, docker: async (args, opts = {}) => { if (args[0] === 'run' && args[1] === '-d') options.set(flag(args, '--name')[0], opts); return docker.docker(args, opts) } }
  const preview = { origins: ['https://server.example', 'https://afterprompt.games'], files: {
    async prepare(id) { return { x11: `/state/box-view/${id}/x11`, socket: `/state/box-view/${id}/socket` } },
    async remove() {} } }
  return { h: host({ docker: recording, server, clock, publisher: { ...extra, preview } }), options }
}
const previewKey = 'f'.repeat(64)

test('an idle L4 Compute box is saved with its viewer stopped, and a box restored on a new machine gets a viewer again', async () => {
  const docker = fakeDocker(), server = fakeServer(), p = publisher()
  const { h } = previewHost(docker, server, undefined, p.options)
  server.answer = () => [want({ checkpoint: true, preview: { key: previewKey } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.viewers.get(boxId)?.key, previewKey)
  h.clock.now += BOX_IDLE_MS
  await h.boxes.sync(); await h.boxes.settled()
  // Saved and stopped: the viewer went before the disk was saved, and nothing is reported to watch.
  assert.equal(h.boxes.boxes.get(boxId).state, 'stopped')
  assert.equal(h.boxes.viewers.get(boxId), null)
  assert.ok(!docker.containers.has(`l4-view-${boxId}`))
  const removedViewer = docker.calls.findIndex(args => args[0] === 'rm' && args[2] === `l4-view-${boxId}`)
  const savedDisk = docker.calls.findIndex(args => args[0] === 'run' && args.at(-1) === '/opt/l4/checkpoint.mjs')
  assert.ok(removedViewer >= 0 && removedViewer < savedDisk, 'the viewer stops before the save')
  server.answer = () => [want({ want: 'stopped', checkpoint: true })]
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'stopped', runtimeMs: BOX_IDLE_MS, saved: 'e'.repeat(40) }])
  // The machine went; the next turn is on a new machine, restored from the checkpoint, under a new lease and key.
  const restored = fakeDocker(), again = previewHost(restored, server, undefined, p.options)
  server.source = body => ({ id: body.boxId, repository: 'inchidev/afterprompt', baseSha: 'c'.repeat(40), checkpoint: 'e'.repeat(40),
    source: { remote: `https://server.example/api/compute-agent/checkpoint/${body.boxId}.git`, authorization: `Bearer ${'9'.repeat(64)}` } })
  server.answer = () => [want({ lease: leaseB, turn: { runId }, checkpoint: true, preview: { key: 'e'.repeat(64) } })]
  await again.h.boxes.sync(); await again.h.boxes.settled()
  assert.ok(restored.runs().some(args => args.at(-1) === '/opt/l4/checkpoint.mjs'), 'restored from its checkpoint')
  assert.equal(again.h.boxes.viewers.get(boxId)?.key, 'e'.repeat(64))
  assert.ok(restored.containers.has(`l4-view-${boxId}`))
  await waitFor(() => restored.turns.length === 1, 'the turn')
  restored.turns[0].end({ done: true, ok: true, result: 'result' })
})

test('every box has a screen; a box the Server gives a preview key gets a viewer beside it, with voxl’s password only in its environment', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const { h, options } = previewHost(docker, server)
  server.answer = () => [want({ preview: { key: previewKey } })]
  await h.boxes.sync(); await h.boxes.settled()
  const box = docker.runs().find(args => flag(args, '--name')[0] === `l4-box-${boxId}`)
  assert.ok(flag(box, '--env').includes('DISPLAY=:99'))
  assert.deepEqual(flag(box, '--ipc'), ['shareable'])
  assert.ok(box.includes(`type=bind,src=/state/box-view/${boxId}/x11,dst=/tmp/.X11-unix`))
  const viewer = docker.runs().find(args => flag(args, '--name')[0] === `l4-view-${boxId}`)
  for (const [name, value] of [['--network', 'none'], ['--ipc', `container:l4-box-${boxId}`], ['--user', '1000:1000'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges']]) assert.deepEqual(flag(viewer, name), [value], name)
  assert.ok(viewer.includes('--read-only'))
  assert.ok(viewer.includes(`type=bind,src=/state/box-view/${boxId}/x11,dst=/tmp/.X11-unix,readonly`))
  assert.ok(viewer.includes(`type=bind,src=/state/box-view/${boxId}/socket,dst=/run/l4-view`))
  assert.deepEqual(flag(viewer, '--env'), ['DISPLAY=:99', 'VOXL_PASSWORD', 'LLLL_VIEW_ORIGINS=https://server.example,https://afterprompt.games'])
  assert.deepEqual(viewer.slice(-3), [image, 'node', '/opt/l4/viewer.mjs'])
  // The password reaches docker's environment, never its arguments, and neither the box nor the Server.
  const password = options.get(`l4-view-${boxId}`).env.VOXL_PASSWORD
  assert.match(password, /^[a-f0-9]{64}$/u)
  assert.ok(!docker.calls.flat().some(value => value.includes(password)))
  assert.deepEqual(h.boxes.viewers.get(boxId), { boxId, key: previewKey, password, socket: `/state/box-view/${boxId}/socket/voxl.sock` })
  assert.equal(h.boxes.viewers.any(), h.boxes.viewers.get(boxId))
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'idle', runtimeMs: 0, preview: true }])
  assert.ok(!JSON.stringify(server.syncs).includes(password))
  // A new key (the box taken over under a new lease) starts the viewer again with it.
  server.answer = () => [want({ preview: { key: 'e'.repeat(64) } })]
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.viewers.get(boxId).key, 'e'.repeat(64))
  assert.notEqual(h.boxes.viewers.get(boxId).password, password)
  // The box stops when idle whoever watches; its viewer goes with it.
  h.clock.now += BOX_IDLE_MS
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(h.boxes.boxes.get(boxId).state, 'stopped')
  assert.equal(h.boxes.viewers.get(boxId), null)
  assert.ok(!docker.containers.has(`l4-view-${boxId}`))
  await h.boxes.sync()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'stopped', runtimeMs: BOX_IDLE_MS }])
})

test('without a preview key, or on a Node with no gate, a box has its screen and no viewer, and reports nothing new', async () => {
  for (const [gate, answer] of [[true, want()], [false, want({ preview: { key: previewKey } })]]) {
    const docker = fakeDocker(), server = fakeServer()
    const h = gate ? previewHost(docker, server).h : host({ docker, server })
    server.answer = () => [answer]
    await h.boxes.sync(); await h.boxes.settled(); await h.boxes.sync()
    const box = docker.runs().find(args => flag(args, '--name')[0] === `l4-box-${boxId}`)
    assert.ok(flag(box, '--env').includes('DISPLAY=:99'))
    assert.equal(docker.runs().some(args => flag(args, '--name')[0] === `l4-view-${boxId}`), false)
    assert.equal(h.boxes.viewers.get(boxId), null)
    assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'idle', runtimeMs: 0 }])
    if (!gate) assert.equal(flag(box, '--ipc').length, 0)
  }
})

test('a viewer that cannot start leaves the box working and is tried again a minute later, not on every sync', async () => {
  const docker = fakeDocker(), server = fakeServer()
  const failing = { ...docker, docker: async (args, options) => { if (args[0] === 'run' && flag(args, '--name')[0] === `l4-view-${boxId}`) throw new Error('no viewer'); return docker.docker(args, options) } }
  const { h } = previewHost(failing, server)
  server.answer = () => [want({ preview: { key: previewKey }, turn: { runId } })]
  await h.boxes.sync(); await h.boxes.settled()
  await waitFor(() => docker.turns.length === 1, 'the turn')
  assert.equal(h.boxes.viewers.get(boxId), null)
  await h.boxes.sync(); await h.boxes.settled()
  assert.deepEqual(server.syncs.at(-1).boxes, [{ id: boxId, lease: leaseA, state: 'running', runId, runtimeMs: 0, preview: false }])
  const tries = () => docker.calls.filter(args => args[0] === 'rm' && args[2] === `l4-view-${boxId}`).length
  const before = tries()
  await h.boxes.sync(); await h.boxes.settled()
  assert.equal(tries(), before)
  h.clock.now += 60_000
  await h.boxes.sync(); await h.boxes.settled()
  assert.ok(tries() > before)
  docker.turns[0].end({ done: true, ok: true, result: 'result' })
})
