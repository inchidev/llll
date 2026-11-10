import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createBoxCa } from './box-ca.mjs'
import { pushRef } from './push-branch.mjs'

/** A box with no turn for this long stops; its disk stays until its Task is Done, or on L4 Compute until it is saved. */
export const BOX_IDLE_MS = 15 * 60 * 1000
/** How long a new box may take to answer its first health check before it counts as failed to start. */
export const BOX_READY_MS = 90 * 1000
const MAX_REPORTED = 64, NO_LEASE = '0'.repeat(64)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const lease = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const names = id => ({ box: `l4-box-${id}`, egress: `l4-egress-${id}`, network: `l4-boxnet-${id}`, volume: `l4-disk-${id}`, checkout: `l4-checkout-${id}`, copy: `l4-copy-${id}`, push: `l4-push-${id}`, save: `l4-save-${id}`, view: `l4-view-${id}` })
/** The box's screen: Xvfb in the box (packages/agent-runtime/src/display.mjs), the Agent's browser on it. */
export const BOX_DISPLAY = ':99'
/** A viewer that failed to start is tried again this long after, not on every sync. */
const VIEWER_RETRY_MS = 60000
const previewKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'FTP_PROXY', 'ftp_proxy']
/** Where the box finds its own authority: Node adds it to its roots, the rest read the bundle with the system roots. */
const BOX_CA = ['--env', 'NODE_EXTRA_CA_CERTS=/run/l4-ca/ca.pem', ...['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE'].flatMap(key => ['--env', `${key}=/run/l4-ca/bundle.pem`])]

/** What the conversation hears when a box on a new machine cannot get its saved work back. */
export const RESTORE_FAILED = 'The Agent’s box could not bring back its saved work on a new machine, and did not start over from the repository instead. Ask again; if this happens again, the Task’s checkpoint needs a look.'

/** Why a box refused a turn, in the box's own words when they are short and plain, for the conversation. */
export function refusal(error) {
  const reason = typeof error === 'string' && /^[\w .,:;()'’-]{1,200}$/u.test(error) ? ` (${error})` : ''
  return `The Agent’s box refused this turn${reason}. Ask again.`
}

/** Another operation of a Run's gateway, next to its tools endpoint. */
function gatewayUrl(submission, operation) {
  const url = new URL(submission.toolEndpoint)
  if (!url.pathname.endsWith('/gateway/tools')) throw new Error('Invalid gateway endpoint')
  url.pathname = url.pathname.slice(0, -'tools'.length) + operation
  return url.href
}
const lines = output => output.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

/**
 * The boxes of one paired Node, reconciled with what the Server wants on each sync (Node protocol 2).
 *
 * Each box is one long-lived container per Task, `l4-box-<id>`, with the Task's persistent disk at /work
 * and an egress proxy, `l4-egress-<id>`, as its only way out, on an internal network of its own. The Server
 * renews the box's lease on every sync that lists it, hands it turns and asks for it to stop or be released;
 * the Node reports what each box is doing and how long it has run. A box takes a turn through `docker exec`
 * into its control socket, and the box itself reports the turn through the Server's gateway.
 *
 * Starting, stopping and releasing a box run one at a time per box, in the background, so a slow source
 * fetch never delays the sync that keeps every other lease alive. A turn runs beside them.
 *
 * What a box asks to publish leaves it only through this daemon. A throwaway container with no network and
 * the box's disk read-only copies the requested commit into a bare repository on a scratch disk with hardened
 * Git (review-diff.mjs), and for a review writes its diff, which goes to the Server. Once the push is approved,
 * another throwaway container pushes exactly that commit from the copy to the Task’s branch (or, under a
 * direct_push Git flow, to the base branch as a fast-forward only) with a short
 * credential the Server grants for it (push-branch.mjs); a GitHub token is revoked right after. One such
 * publication runs at a time on a Node, beside turns.
 *
 * The box's network is what the Server's sync names (box-egress.ts on the Server): this daemon writes it to a
 * policy file its proxy reads, read-only, and rewrites it whenever its revision changes. For a host with a bound
 * Project secret the proxy terminates TLS with the box's own authority, made fresh for each start; the box gets
 * only its certificate. The authority's key and the secrets' values go to the proxy through its control socket
 * by docker exec, never through a disk, an environment variable or the box.
 *
 * On L4 Compute, where the machine is billed for as long as it lives, the Server's sync says `checkpoint`: an idle
 * box is then stopped, its disk saved to the box's private checkpoint repository through the Server (checkpoint.mjs:
 * a throwaway container with no network writes it to the scratch disk, another with the scratch disk only pushes it),
 * and once the Server has acknowledged it the box is reported stopped with that checkpoint, so the Server may let the
 * machine go. A box starting on a new machine is restored from its checkpoint instead of the pinned source.
 *
 * Every box has a screen (`DISPLAY`) for the Agent's browser. On a Node with a preview gate (`preview`, which only
 * L4 Compute sets up), a box the Server gives a preview key also gets a viewer, `l4-view-<id>`: voxl streaming that
 * screen, with no network, sharing only the box's X socket and shared memory. The gate (preview-gate.mjs) lets a
 * person in with a ticket the Server minted from that key; voxl's own password is made here for each viewer and
 * goes only to the viewer. Viewing is no turn: a box with only viewers stops when idle like any other, its viewer
 * with it, and a box started again on its checkpoint gets a viewer again.
 */
export function createBoxHost({ docker, poll, disks, fetchSource, records, connection, image, server, capacity, diskFree,
  scratch, upload, egressFiles, preview = null, revoke = async () => {}, fetcher = fetch, now = Date.now, idleMs = BOX_IDLE_MS, readyMs = BOX_READY_MS,
  readyRetryMs = 1000, log = () => {} }) {
  const boxes = new Map()
  const labels = (box) => ['--label', `l4.node=${connection.nodeId}`, '--label', `l4.server=${connection.serverId}`, '--label', `l4.box=${box.id}`, '--label', `l4.task=${box.taskId}`]
  let rotation = 0

  const track = saved => {
    const box = { id: saved.id, lease: saved.lease, taskId: saved.taskId, ready: Boolean(saved.ready), runtimeMs: saved.runtimeMs ?? 0, state: 'stopped',
      upSince: null, lastActive: now(), runId: null, finished: new Set(), pending: null, queue: Promise.resolve(), answer: null, mount: null, checkpoint: false, saved: null }
    boxes.set(box.id, box)
    return box
  }
  const save = box => records.save({ id: box.id, lease: box.lease, taskId: box.taskId, ready: box.ready, runtimeMs: box.runtimeMs })
  const runtime = box => Math.floor(box.runtimeMs + (box.upSince === null ? 0 : now() - box.upSince))
  const enqueue = (box, work) => {
    box.queue = box.queue.then(work).catch(error => log('compute.box_operation_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
    return box.queue
  }

  for (const saved of records.list()) track(saved)

  /** What the Node reports: boxes at work first, then stopped ones in turn, so each hears about its release. */
  function report() {
    const all = [...boxes.values()]
    const working = all.filter(box => box.state !== 'stopped'), stopped = all.filter(box => box.state === 'stopped')
    const room = Math.max(0, MAX_REPORTED - working.length)
    const start = stopped.length ? rotation % stopped.length : 0
    rotation += room
    const listed = [...working.slice(0, MAX_REPORTED), ...[...stopped.slice(start), ...stopped.slice(0, start)].slice(0, room)]
    // A box being stopped no longer counts against the Node; one being saved keeps its lease, which its save needs.
    // A stopped box says which acknowledged checkpoint its disk is, with no turn since: the Server may then let it go.
    // A viewer is reported only to a Server that gave the box a preview key, so an earlier Server never sees the field.
    return listed.map(box => ({ id: box.id, lease: box.lease, state: box.state === 'stopping' ? 'stopped' : box.state === 'saving' ? 'idle' : box.state,
      ...(box.runId ? { runId: box.runId } : {}), runtimeMs: runtime(box), ...(box.state === 'stopped' && box.saved ? { saved: box.saved } : {}),
      ...(box.previewAsked ? { preview: Boolean(box.viewer) && ['idle', 'running'].includes(box.state) } : {}) }))
  }

  async function control(box, request, options = {}) {
    const output = await docker(['exec', '-i', names(box.id).box, 'node', '/opt/agent/src/control.mjs'], { input: JSON.stringify(request), timeoutMs: 30000, limit: 100000, ...options })
    return lines(output)
  }

  /**
   * A new box's health, asked again while its control socket does not listen yet: control.mjs waits ten seconds for
   * it, and on a busy machine the box's code takes longer to load (measured 12 to 17 s on a Small L4 Compute box).
   */
  async function health(box) {
    const until = Date.now() + readyMs
    for (;;) {
      try { return (await control(box, { op: 'health' })).at(-1) }
      catch (error) { if (Date.now() + readyRetryMs >= until) throw error }
      await new Promise(resolve => setTimeout(resolve, readyRetryMs))
    }
  }

  /** Ends a Run's turn that never reached its box, so the conversation hears why instead of waiting. */
  async function failTurn(box, runId, message) {
    try {
      const { submission } = await poll({ operation: 'turn', boxId: box.id, lease: box.lease, runId })
      if (submission?.runId !== runId) return
      const response = await fetcher(gatewayUrl(submission, 'events'), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${submission.modelGateway.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 0, events: [], result: { type: 'error', message } }) })
      await response.body?.cancel()
    } catch { /* The Run ends at its deadline instead. */ }
  }

  /**
   * The box's first start on this Node: the Task's pinned source, or for a box that gave its machine back, its
   * acknowledged checkpoint, fetched the same way and restored in the same throwaway container. A checkpoint that
   * cannot be restored fails the start; the box never starts over from the pinned source instead.
   */
  async function bootstrap(box) {
    const grant = await poll({ operation: 'source', boxId: box.id, lease: box.lease })
    const restoring = grant?.checkpoint !== undefined
    try {
      if (restoring && !commit(grant.checkpoint)) throw new Error('Invalid checkpoint grant')
      const fetched = await fetchSource(restoring ? { ...grant, baseSha: grant.checkpoint } : grant)
      try {
        const output = await docker(['run', '--rm', '-i', '--name', names(box.id).checkout, ...labels(box), '--network', 'none', '--read-only', '--user', '1000:1000',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '1g', '--cpus', '1',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000', '--mount', `type=volume,src=${names(box.id).volume},dst=/work`,
          '--mount', `type=bind,src=${fetched.bundle},dst=/bootstrap/source.bundle,readonly`, image, 'node', restoring ? '/opt/l4/checkpoint.mjs' : '/opt/agent/src/checkout.mjs'],
        { input: JSON.stringify(restoring ? { operation: 'restore', checkpoint: grant.checkpoint, baseSha: grant.baseSha } : { baseSha: grant.baseSha }), timeoutMs: 300000, limit: 10000 })
        if (!lines(output).at(-1)?.ok) throw new Error('Checkout failed')
      } finally { await fetched.release() }
    } catch (error) { throw restoring ? Object.assign(new Error('Restore failed', { cause: error }), { restore: true }) : error }
  }

  let systemRoots = null
  /** The image's own public roots, which the box's bundle adds its authority to. */
  async function rootsOfImage() {
    systemRoots ??= docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', image, 'cat', '/etc/ssl/certs/ca-certificates.crt'],
      { timeoutMs: 60000, limit: 4000000 }).catch(error => { systemRoots = null; throw error })
    return systemRoots
  }
  /** The policy the proxy reads: this Server always, and what the Server's sync allows. */
  const policyOf = egress => {
    const hosts = [...new Set([new URL(server).hostname, ...(Array.isArray(egress?.hosts) ? egress.hosts : [])])]
    return { revision: String(egress?.revision ?? ''), hosts, secretHosts: (Array.isArray(egress?.secretHosts) ? egress.secretHosts : []).filter(host => hosts.includes(host)) }
  }
  /** Hands the proxy its authority and the secrets in effect; only a policy with a bound host needs their values. */
  async function loadEgress(box, policy) {
    const secrets = policy.secretHosts.length ? await poll({ operation: 'secrets', boxId: box.id, lease: box.lease }) : { revision: policy.revision, known: [], secrets: [] }
    const input = JSON.stringify({ revision: secrets.revision, ca: box.ca, known: secrets.known ?? [], secrets: secrets.secrets ?? [] })
    for (let attempt = 0; ; attempt++) {
      const answer = lines(await docker(['exec', '-i', names(box.id).egress, 'node', '/opt/l4/proxy.mjs', 'load'], { input, timeoutMs: 15000, limit: 10000 }).catch(() => '')).at(-1)
      if (answer?.ok === true) return
      if (attempt >= 20) throw new Error('The egress proxy did not take its policy')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  /** A new revision from the Server: values first, so a closed window takes its secret with it, then the hosts. */
  function refreshEgress(box, egress) {
    const policy = policyOf(egress)
    if (!box.ca || box.egressRevision === policy.revision || box.egressPending === policy.revision) return
    box.egressPending = policy.revision
    box.egressQueue = (box.egressQueue ?? Promise.resolve()).then(async () => {
      if (!box.ca || !['idle', 'running'].includes(box.state)) return
      await loadEgress(box, policy)
      await egressFiles.writePolicy(box.id, policy)
      box.egressRevision = policy.revision
    }).catch(error => log('compute.box_egress_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
      .finally(() => { if (box.egressPending === policy.revision) box.egressPending = null })
  }

  /** The box's viewer, for the key the Server gave this start. It never holds up the box: a viewer that fails is only not there. */
  async function startViewer(box, key) {
    const { box: name, view } = names(box.id)
    box.viewer = null
    await docker(['rm', '-f', view]).catch(() => {})
    try {
      const files = await preview.files.prepare(box.id), password = randomBytes(32).toString('hex')
      await docker(['run', '-d', '--name', view, ...labels(box), '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '512m', '--cpus', '1', '--ipc', `container:${name}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000',
        '--mount', `type=bind,src=${files.x11},dst=/tmp/.X11-unix,readonly`, '--mount', `type=bind,src=${files.socket},dst=/run/l4-view`,
        '--env', `DISPLAY=${BOX_DISPLAY}`, '--env', 'VOXL_PASSWORD', '--env', `LLLL_VIEW_ORIGINS=${preview.origins.join(',')}`, image, 'node', '/opt/l4/viewer.mjs'],
      { env: { VOXL_PASSWORD: password } })
      box.viewer = { boxId: box.id, key, password, socket: join(files.socket, 'voxl.sock') }
    } catch (error) {
      box.viewerFailed = { key, at: now() }
      await docker(['rm', '-f', view]).catch(() => {})
      log('compute.box_viewer_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' })
    }
  }
  /** A key the box did not start with (a Server that began to give one): the viewer starts, or starts again, beside the box. */
  function refreshViewer(box, key) {
    if (!preview || !previewKey(key) || box.viewer?.key === key || box.viewerPending === key) return
    if (box.viewerFailed?.key === key && now() - box.viewerFailed.at < VIEWER_RETRY_MS) return
    box.viewerPending = key
    enqueue(box, async () => { if (['idle', 'running'].includes(box.state)) await startViewer(box, key) }).finally(() => { if (box.viewerPending === key) box.viewerPending = null })
  }

  async function removeContainers(box) {
    const { box: name, egress, network, view } = names(box.id)
    box.viewer = null
    await docker(['rm', '-f', view]).catch(() => {})
    await docker(['rm', '-f', name]).catch(() => {})
    await docker(['rm', '-f', egress]).catch(() => {})
    await docker(['network', 'rm', network]).catch(() => {})
  }

  async function start(box) {
    const want = box.answer
    if (!want || box.state !== 'starting') return
    const { box: name, egress, network, volume } = names(box.id)
    // From here the disk may change again: it is no longer the checkpoint it was saved as.
    box.saved = null
    try {
      if (want.image !== image) throw new Error('The Server names another box image')
      let existing
      try { existing = JSON.parse(await docker(['volume', 'inspect', volume]))[0] } catch { /* Missing volume only. */ }
      if (existing && (existing.Labels?.['l4.server'] !== connection.serverId || existing.Labels?.['l4.node'] !== connection.nodeId || existing.Labels?.['l4.box'] !== box.id || existing.Labels?.['l4.task'] !== box.taskId)) throw new Error('Foreign box volume')
      const mount = await disks.ensure(box.id, !existing, want.diskBytes)
      if (existing && (existing.Driver !== 'local' || existing.Options?.device !== mount)) throw new Error('Box volume is not bound to its hard-quota disk')
      if (!existing) await docker(['volume', 'create', ...labels(box), '--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind', '--opt', `device=${mount}`, volume])
      box.mount = mount
      if (!box.ready) { await bootstrap(box); box.ready = true; save(box) }
      await removeContainers(box)
      // The box reaches only its egress proxy; the proxy reaches only this Server and the hosts the Server allows.
      // A fresh authority for each start: its key never touches a disk.
      box.ca = createBoxCa(box.id)
      box.egressRevision = null
      const policy = policyOf(want.egress), files = await egressFiles.prepare(box.id)
      await egressFiles.writeCa(box.id, box.ca.cert, `${(await rootsOfImage()).trimEnd()}\n${box.ca.cert}`)
      await egressFiles.writePolicy(box.id, policy)
      await docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true', ...labels(box), network])
      await docker(['run', '-d', '--name', egress, ...labels(box), '--network', network, '--network-alias', 'l4-egress', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '64', '--mount', `type=bind,src=${files.policy},dst=/run/l4-policy,readonly`,
        '--tmpfs', '/run/egress:rw,noexec,nosuid,size=1m,uid=1000,gid=1000', ...PROXY_VARIABLES.slice(0, 3).flatMap(key => ['--env', `${key}=`]), image, 'node', '/opt/l4/proxy.mjs'])
      await docker(['network', 'connect', 'bridge', egress])
      const address = JSON.parse(await docker(['inspect', egress]))[0]?.NetworkSettings?.Networks?.[network]?.IPAddress
      if (typeof address !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) throw new Error('Egress proxy has no address')
      const proxy = `http://${address}:8080`
      await loadEgress(box, policy)
      box.egressRevision = policy.revision
      // With a preview gate, the box's X socket is in a directory its viewer mounts too, and its shared memory may be joined.
      const view = preview ? await preview.files.prepare(box.id) : null
      await docker(['run', '-d', '--name', name, ...labels(box), '--network', network, '--dns', '127.0.0.1', '--init', '--read-only', '--user', '1000:1000',
        ...(view ? ['--ipc', 'shareable', '--mount', `type=bind,src=${view.x11},dst=/tmp/.X11-unix`] : []), '--env', `DISPLAY=${BOX_DISPLAY}`,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', `${want.memoryMiB}m`, '--memory-swap', `${want.memoryMiB}m`, '--cpus', String(Math.max(0.01, Math.round(want.cpu * 100) / 100)),
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m,uid=1000,gid=1000', '--tmpfs', '/run/l4:rw,noexec,nosuid,size=1m,uid=1000,gid=1000',
        '--mount', `type=volume,src=${volume},dst=/work`, '--mount', `type=bind,src=${files.ca},dst=/run/l4-ca,readonly`, ...BOX_CA,
        ...PROXY_VARIABLES.flatMap(key => ['--env', `${key}=${proxy}`]), '--env', 'NO_PROXY=', '--env', 'no_proxy=',
        '--env', 'NODE_USE_ENV_PROXY=1', '--env', 'HOME=/tmp', image, 'node', '/opt/agent/src/box.mjs'])
      const answer = await health(box)
      if (answer?.status !== 'ready' || answer.checkout !== true) throw new Error('The box did not become ready')
      box.state = 'idle'
      box.upSince = now()
      box.lastActive = now()
      if (preview && previewKey(want.preview?.key)) await startViewer(box, want.preview.key)
    } catch (error) {
      await removeContainers(box)
      box.state = 'failed'
      box.ca = null
      log('compute.box_start_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' })
      const runId = box.pending
      box.pending = null
      if (runId) { box.finished.add(runId); await failTurn(box, runId, error?.restore ? RESTORE_FAILED : 'The Agent’s box could not start on its Compute Node. Check the Node’s disk, source access and Docker, then ask again.') }
      return
    }
    if (box.pending) beginTurn(box, box.pending)
  }

  async function stop(box, state = 'stopped') {
    await removeContainers(box)
    box.previewAsked = false
    box.ca = null
    box.egressRevision = null
    if (box.mount) await disks.flush(box.mount).catch(() => {})
    box.runtimeMs = runtime(box)
    box.upSince = null
    box.runId = null
    box.state = state
    save(box)
  }

  async function release(box) {
    await stop(box)
    const { volume } = names(box.id)
    await docker(['volume', 'rm', volume]).catch(() => {})
    await disks.remove(box.id)
    await egressFiles.remove(box.id).catch(() => {})
    if (preview) await preview.files.remove(box.id).catch(() => {})
    boxes.delete(box.id)
    records.forget(box.id)
  }

  function beginTurn(box, runId) {
    box.pending = null
    if (box.runId || box.finished.has(runId) || box.state !== 'idle') return
    box.runId = runId
    box.state = 'running'
    void (async () => {
      let handed = false
      try {
        const { submission } = await poll({ operation: 'turn', boxId: box.id, lease: box.lease, runId })
        if (submission?.runId !== runId) throw new Error('Turn mismatch')
        handed = true
        const answers = await control(box, { op: 'turn', submission }, { timeoutMs: (submission.timeoutMs ?? 300000) + 120000 })
        if (answers[0]?.accepted !== true) await failTurn(box, runId, refusal(answers[0]?.error))
      } catch (error) {
        // A turn the Run has not handed over yet is asked for again on a later sync.
        if (error?.status === 409 && !handed) { box.runId = null; if (box.state === 'running') box.state = 'idle'; return }
        log('compute.box_turn_failed', { boxId: box.id })
      }
      box.finished.add(runId)
      if (box.finished.size > 64) box.finished.delete(box.finished.values().next().value)
      if (box.runId === runId) box.runId = null
      if (box.state === 'running') box.state = 'idle'
      box.lastActive = now()
    })()
  }

  // One publication at a time per Node: the scratch disk holds one copy.
  let publishing = Promise.resolve()
  const outward = new Set()
  const hardened = ['--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '1g', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000']

  /** Copies the commit out of the box's disk into a fresh bare repository on the scratch disk; with a review, its diff. */
  async function copyCommit(box, work, directory, review) {
    const output = await docker(['run', '--rm', '-i', '--name', names(box.id).copy, ...labels(box), '--network', 'none', ...hardened,
      '--mount', `type=volume,src=${names(box.id).volume},dst=/box,readonly`, '--mount', `type=bind,src=${directory},dst=/mirror`, image, 'node', '/opt/l4/review-diff.mjs'],
    { input: JSON.stringify({ sha: work.sha, baseSha: work.baseSha, review }), timeoutMs: 600000, limit: 2700000 }).catch(error => { throw Object.assign(new Error('Copy failed'), { cause: error, output: error.output }) })
    return lines(output).at(-1) ?? { ok: false, message: 'The copy gave no answer' }
  }

  async function reviewPush(box, work) {
    const id = crypto.randomUUID(), directory = await scratch.ensure(id)
    try {
      let result
      try { result = await copyCommit(box, work, directory, true) } catch { result = { ok: false, message: 'The commit could not be copied from the box' } }
      await upload(work.approvalId, result.ok ? { ok: true, review: result.review } : { ok: false, message: String(result.message ?? 'The commit could not be reviewed').slice(0, 300) })
    } finally { await scratch.remove(id).catch(() => {}) }
  }

  async function publishPush(box, work) {
    const id = crypto.randomUUID(), directory = await scratch.ensure(id)
    let grant = null, ok = false, message
    try {
      // Claiming the push gives its credential; it never enters the box or the copy's container.
      grant = await poll({ operation: 'publish', approvalId: work.approvalId })
      if (grant?.sha !== work.sha || grant.ref !== work.ref || (grant.direct === true) !== (work.direct === true)) { message = 'The Server granted another push'; return }
      const copied = await copyCommit(box, work, directory, false).catch(() => ({ ok: false, message: 'The commit could not be copied from the box' }))
      if (!copied.ok) { message = String(copied.message ?? 'The commit could not be copied').slice(0, 300); return }
      const output = await docker(['run', '--rm', '-i', '--name', names(box.id).push, ...labels(box), '--network', 'bridge', ...hardened,
        '--mount', `type=bind,src=${directory},dst=/mirror`, image, 'node', '/opt/l4/push-branch.mjs'],
      { input: JSON.stringify({ remote: grant.remote, ref: grant.ref, sha: grant.sha, expectedOld: grant.expectedOld ?? null, ...(work.direct === true ? { fastForward: true } : {}),
        ...(grant.token ? { token: grant.token } : { authorization: grant.authorization }) }), timeoutMs: 600000, limit: 10000 })
        .catch(error => String(error?.output ?? ''))
      const answer = lines(output).at(-1)
      ok = answer?.ok === true
      // The helper's reason is Git's, with the credential taken out.
      if (!ok) message = typeof answer?.message === 'string' && answer.message ? answer.message.slice(0, 300) : 'The repository refused the push'
    } catch (error) {
      // No grant: the Server did not let this push go ahead (already claimed, or the branch moved).
      if (!grant) { log('compute.box_publish_refused', { boxId: box.id, status: error?.status }); return }
      message = 'The push failed'
    } finally {
      if (grant?.token) await revoke(grant.token).catch(() => {})
      if (grant) await poll({ operation: 'published', approvalId: work.approvalId, ok, ...(message ? { message } : {}) }).catch(error => log('compute.box_published_failed', { boxId: box.id, status: error?.status }))
      await scratch.remove(id).catch(() => {})
    }
  }

  /** The Server's word on a running box's pushes: make a review, or push what was approved. */
  function outwardWork(box, answer) {
    for (const [work, run] of [[answer.review, reviewPush], [answer.publish, publishPush]]) {
      if (!work || !uuid(work.approvalId) || !commit(work.sha) || !commit(work.baseSha) || outward.has(work.approvalId)) continue
      // The box's own branch, or under a direct_push Git flow the base branch as a fast-forward.
      if (run === publishPush && !pushRef(work.ref, { boxId: box.id, fastForward: work.direct === true })) continue
      outward.add(work.approvalId)
      publishing = publishing.then(() => run(box, work))
        .catch(error => log('compute.box_publication_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
        .finally(() => outward.delete(work.approvalId))
    }
  }

  /**
   * Saves a stopped box's disk as its checkpoint, through the Server with the capability it grants for this box and
   * lease, and has the Server acknowledge it. Returns the acknowledged checkpoint. It uses the scratch disk, so it
   * waits for any publication, as each publication waits for the one before.
   */
  async function checkpoint(box) {
    const grant = await poll({ operation: 'checkpoint', boxId: box.id, lease: box.lease })
    if (!commit(grant?.baseSha) || (grant.previous !== null && !commit(grant.previous)) || typeof grant.remote !== 'string' || typeof grant.authorization !== 'string') throw new Error('Invalid checkpoint grant')
    const id = crypto.randomUUID(), directory = await scratch.ensure(id)
    try {
      const saved = lines(await docker(['run', '--rm', '-i', '--name', names(box.id).save, ...labels(box), '--network', 'none', ...hardened,
        '--mount', `type=volume,src=${names(box.id).volume},dst=/work`, '--mount', `type=bind,src=${directory},dst=/mirror`, image, 'node', '/opt/l4/checkpoint.mjs'],
      { input: JSON.stringify({ operation: 'save', baseSha: grant.baseSha, previous: grant.previous }), timeoutMs: 600000, limit: 10000 })).at(-1)
      if (!saved?.ok || !commit(saved.checkpoint) || !commit(saved.head)) throw new Error('The checkpoint could not be written')
      // The capability goes on stdin to a container with the copy only; the box's disk is not there.
      const pushed = lines(await docker(['run', '--rm', '-i', '--name', names(box.id).push, ...labels(box), '--network', 'bridge', ...hardened,
        '--mount', `type=bind,src=${directory},dst=/mirror`, image, 'node', '/opt/l4/checkpoint.mjs'],
      { input: JSON.stringify({ operation: 'push', remote: grant.remote, authorization: grant.authorization, sha: saved.checkpoint }), timeoutMs: 600000, limit: 10000 })).at(-1)
      if (!pushed?.ok) throw new Error('The checkpoint could not be pushed')
      await poll({ operation: 'checkpointed', boxId: box.id, lease: box.lease, checkpoint: saved.checkpoint, head: saved.head })
      return saved.checkpoint
    } finally { await scratch.remove(id).catch(() => {}) }
  }

  /** An idle box on L4 Compute: it stops, so nothing writes while its disk is saved, and is reported stopped with its checkpoint. */
  async function park(box) {
    if (box.state !== 'saving') return
    await removeContainers(box)
    let saved = null
    const saving = publishing.then(() => checkpoint(box))
    publishing = saving.catch(() => {})
    try { saved = await saving } catch (error) { log('compute.box_checkpoint_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed', status: error?.status }) }
    // Unsaved, the box only stops: its disk and machine stay until the next idle save or the Task is Done.
    await stop(box)
    box.saved = saved
  }

  function apply(answer) {
    if (!answer || !uuid(answer.id) || !lease(answer.lease) || !['running', 'stopped', 'released'].includes(answer.want)) return
    let box = boxes.get(answer.id)
    if (answer.want === 'released') { if (box) enqueue(box, () => release(box)); return }
    if (!box) {
      if (answer.want !== 'running' || !uuid(answer.taskId)) return
      box = track({ id: answer.id, lease: answer.lease, taskId: answer.taskId, ready: false })
      save(box)
    }
    if (answer.want === 'stopped') {
      if (!['stopped', 'stopping'].includes(box.state)) { box.state = 'stopping'; enqueue(box, () => stop(box)) }
      return
    }
    // The box holds this lease now; one the Node held before is taken over, its containers kept.
    if (box.lease !== answer.lease) { box.lease = answer.lease; save(box) }
    box.answer = answer
    box.checkpoint = answer.checkpoint === true
    box.previewAsked = Boolean(preview && previewKey(answer.preview?.key))
    const turn = uuid(answer.turn?.runId) ? answer.turn.runId : null
    if (answer.cancelRunId && box.runId === answer.cancelRunId) void control(box, { op: 'cancel', runId: answer.cancelRunId }).catch(() => {})
    if (box.state === 'stopped' || box.state === 'failed') {
      box.state = 'starting'
      box.pending = turn
      enqueue(box, () => start(box))
      return
    }
    if (turn && box.state === 'starting') box.pending = turn
    if (['idle', 'running'].includes(box.state) && answer.egress) refreshEgress(box, answer.egress)
    if (['idle', 'running'].includes(box.state)) refreshViewer(box, answer.preview?.key)
    if (turn && box.state === 'idle') beginTurn(box, turn)
    if (['idle', 'running'].includes(box.state) && scratch && upload) outwardWork(box, answer)
  }

  return {
    boxes,
    report,
    /** The viewers the preview gate may open: a box's own by its ticket, and any one for voxl's public assets. */
    viewers: {
      get: id => { const box = boxes.get(id); return box?.viewer && ['idle', 'running'].includes(box.state) ? box.viewer : null },
      any: () => [...boxes.values()].find(box => box.viewer && ['idle', 'running'].includes(box.state))?.viewer ?? null,
    },
    /** One sync: report every box, renew their leases and do what the Server answers. */
    async sync() {
      const answer = await poll({ operation: 'sync', capacity: { ...capacity, diskFree: await diskFree() }, boxes: report() })
      for (const box of Array.isArray(answer?.boxes) ? answer.boxes : []) apply(box)
      for (const box of boxes.values()) if (box.state === 'idle' && !box.runId && now() - box.lastActive >= idleMs) {
        // On L4 Compute the box is saved first, so its machine can go; it keeps its lease meanwhile.
        if (box.checkpoint && scratch) { box.state = 'saving'; enqueue(box, () => park(box)) }
        else { box.state = 'stopping'; enqueue(box, () => stop(box)) }
      }
    },
    /** Every queued start, stop and release, and every publication, has finished. */
    async settled() { await Promise.all([...boxes.values()].flatMap(box => [box.queue, box.egressQueue])); await publishing },
    /** A box disk this Node has without a record is reported until the Server says what it is. */
    adopt(id, taskId) { if (uuid(id) && uuid(taskId) && !boxes.has(id)) save(track({ id, lease: NO_LEASE, taskId, ready: false })) },
    /** The daemon stops: boxes stop with it, and their disks stay. */
    async shutdown() { await Promise.all([...boxes.values()].map(box => enqueue(box, () => box.state === 'stopped' ? undefined : stop(box)))) },
  }
}
