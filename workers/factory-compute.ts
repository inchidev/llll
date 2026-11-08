import type {} from '../types/agent-exports'
import { DurableObject } from 'cloudflare:workers'
import type { L4Env } from './env'
import type { RuntimeEvent } from '../shared/agent-execution'
import type { RunEnvironment } from '../shared/code-environments'
import { cloudflareCapabilities, factoryImageAccepted, factoryRepositoryName } from '../shared/software-factory'
import { computeBoxSource } from '../server/utils/compute-nodes'
import { boxRun, cloudBox, cloudBoxName, computeTurn, syncBoxes, wakeCloudBox, type CloudBox } from '../server/utils/factory-boxes'
import { giteaRemote } from '../server/utils/gitea'
import { claimPublication, publishedApproval, submitReview } from '../server/utils/factory-approvals'
import { githubPushGrant, revokeGithubToken } from '../server/utils/github-agent-client'
import { artifactsGrant, type ArtifactsGrant } from '../server/utils/factory-artifacts'
import { readLimitedStream } from './inbound-email-signature'
import { getServerId } from '../shared/server-id'
import { nowIso } from '../shared/ids'
import { cloudCodeBridge } from './factory-code-bridge'
import type { BoxEgress } from './factory-outbound'

/** A box with no turn for this long checkpoints and stops; the next turn restores it from Artifacts. */
export const CLOUD_BOX_IDLE_MS = 10 * 60 * 1000
/** A running box syncs this often: its lease lasts a minute, and a turn's end is seen within this. */
export const CLOUD_BOX_TICK_MS = 15000
/** A box waiting for room on its Node asks again this often, in case a box stopped without waking it. */
const QUEUED_TICK_MS = 30000
const NO_LEASE = '0'.repeat(64), KEPT_TURNS = 64
const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)

type Checkpoint = { sha: string; repository: string; image: string; updatedAt: string }
type Capabilities = ReturnType<typeof cloudflareCapabilities.parse>
/** What this object remembers of its box between alarms. */
type BoxState = { lease?: string; ready?: boolean; turn?: string; handed?: string[]; dirty?: boolean; lastActive?: number; upSince?: number; runtimeMs?: number }
type ControlAnswer = { accepted?: boolean; status?: string; runId?: string; checkout?: boolean; ok?: boolean; error?: string }

class FactoryIoError extends Error {
  constructor(readonly code: 'helper_stream_limit' | 'helper_exit' | 'helper_json') { super(code) }
}
async function discardDiagnostics(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return
  const reader = stream.getReader(); let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      size += value?.byteLength ?? 0
      if (size > 10000) { await reader.cancel().catch(() => undefined); throw new FactoryIoError('helper_stream_limit') }
    }
  } finally { reader.releaseLock() }
}
/** The first JSON line a control request answers; a turn's last line comes only when the turn ends. */
async function firstLine(stream: ReadableStream<Uint8Array> | null, limit = 100000): Promise<ControlAnswer | null> {
  if (!stream) return null
  const reader = stream.getReader(), decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) text += decoder.decode(value, { stream: true })
      const end = text.indexOf('\n')
      if (end >= 0 || done || text.length > limit) {
        try { return JSON.parse(end >= 0 ? text.slice(0, end) : text) as ControlAnswer } catch { return null }
      }
    }
  } finally { await reader.cancel().catch(() => undefined) }
}

/**
 * The Agent's box on Cloudflare: one Durable Object and one long-lived container per Task box, running the
 * same box image and runtime as a VPS Node (packages/agent-runtime/src/box.mjs).
 *
 * There is no daemon here. The object syncs its own box with the Server, through the same sync and admission
 * a paired Node uses, so a Cloudflare Node never runs more boxes than its application's containers. It starts
 * the container when the Server wants it running, restores the Task's checkout from its Artifacts repository
 * (or clones the pinned source on the first start), hands each turn to the box through its control socket,
 * passes cancellation the same way, checkpoints to Artifacts when a turn ends and before it stops, and stops
 * the container after CLOUD_BOX_IDLE_MS without a turn. A turn that began in a container that is gone ends
 * with an error instead of running twice.
 *
 * The container reaches nothing but what BoxOutbound allows for the box's lease: the Server's gateway, and
 * the Task's own Artifacts repository or pinned source while a trusted helper restores or checkpoints it.
 *
 * What the Agent asks to publish is reviewed and pushed by a trusted helper in the container, from a copy of
 * the commit in a bare repository of its own. Its push goes out through BoxOutbound with a grant for exactly
 * that commit and the Task's branch: the outbound Worker reads the push's commands, refuses any other update
 * and adds the single-repository credential itself. The Server then checks the branch before the PR.
 */
export class FactoryComputeDurableObject extends DurableObject<L4Env> {
  override async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).pathname.slice(1)
    if (id === 'probe' && request.method === 'POST' && this.env.FACTORY_COMPUTE && this.ctx.container) {
      const expected = this.env.FACTORY_COMPUTE.idFromName(`probe:${await getServerId(this.env.DB)}`)
      if (!this.ctx.id.equals(expected)) return new Response('Invalid probe scope', { status: 403 })
      const container = this.ctx.container
      try {
        if (container.running) await container.destroy()
        await container.start({ entrypoint: ['/bin/sleep', 'infinity'], enableInternet: false })
        await container.setInactivityTimeout(1000)
        for (let attempt = 0; ; attempt++) {
          try { const process = await container.exec(['/usr/local/bin/node', '-e', 'if(process.getuid()!==1000)process.exit(1)'], { user: '1000:1000', stdout: 'ignore', stderr: 'ignore' }); if (await process.exitCode !== 0) throw new Error('Image user mismatch'); break }
          catch (error) { if (attempt >= 60) throw error; await scheduler.wait(500) }
        }
        const running = await container.inspect()
        if (!factoryImageAccepted(running?.image, this.env.FACTORY_IMAGE ?? '')) throw new Error('Released container image mismatch')
        return Response.json({ ready: true })
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Container probe failed'
        return Response.json({ ready: false, message }, { status: 503 })
      } finally {
        try { if (container.running) await container.destroy() } catch { /* Teardown must not replace the probe result. */ }
      }
    }
    return new Response('Not found', { status: 404 })
  }

  /** The Server has news for this box: a turn, a cancellation, room on its Node or its release. */
  async wake(boxId: string): Promise<void> {
    if (!uuid(boxId) || !this.env.FACTORY_COMPUTE || !this.ctx.id.equals(this.env.FACTORY_COMPUTE.idFromName(cloudBoxName(boxId)))) throw new Error('Invalid box scope')
    await this.ctx.storage.put('boxId', boxId)
    await this.ctx.storage.setAlarm(Date.now())
  }

  override async alarm(): Promise<void> {
    const boxId = await this.ctx.storage.get<string>('boxId')
    if (!boxId) return
    const box = await cloudBox(this.env, boxId)
    if (!box) {
      // Not a Cloudflare box of this Server any more. Its checkpoint stays: only a release removes Task code.
      if (this.ctx.container?.running) await this.ctx.container.destroy()
      return
    }
    const state = await this.ctx.storage.get<BoxState>('box') ?? {}
    let next: number | null
    try { next = await this.reconcile(box, state) }
    catch (error) {
      console.warn('factory.box_failed', { boxId, error: error instanceof Error ? error.message : 'failed' })
      next = this.ctx.container?.running || state.turn ? Date.now() + CLOUD_BOX_TICK_MS : null
    } finally {
      if (await this.ctx.storage.get('boxId')) await this.ctx.storage.put('box', state)
    }
    if (next === null) return
    // A wake during this alarm asked for an earlier one; keep it.
    const scheduled = await this.ctx.storage.getAlarm()
    if (scheduled === null || scheduled > next) await this.ctx.storage.setAlarm(next)
  }

  /** One pass: see what the box is doing, sync it with the Server, do what the Server wants. Returns the next alarm. */
  private async reconcile(box: CloudBox, state: BoxState): Promise<number | null> {
    const container = this.ctx.container
    const parsed = cloudflareCapabilities.safeParse(JSON.parse(box.capabilitiesJson))
    if (!parsed.success) {
      if (container?.running) await container.destroy()
      this.stopped(state)
      return null
    }
    const capabilities = parsed.data
    const usable = Boolean(box.enabled) && Boolean(container) && Boolean(this.env.FACTORY_CODE) && capabilities.image === this.env.FACTORY_IMAGE
    state.handed ??= []
    state.lastActive ??= Date.now()

    // What the box is doing now.
    const running = Boolean(container?.running) && state.ready === true
    if (!running && state.ready) this.stopped(state)
    if (!running && state.turn) {
      const lost = state.turn
      state.turn = undefined
      await this.failTurn(lost, 'The Agent’s box stopped during this turn. Ask again to continue.')
    }
    if (running && state.turn) {
      const health = await this.control({ op: 'health' }).catch(() => null)
      if (health && (health.status !== 'running' || health.runId !== state.turn)) {
        state.turn = undefined
        state.lastActive = Date.now()
        // The turn has ended: its work goes to Artifacts before anything else happens in the box.
        await this.checkpoint(box, capabilities, state).catch(error => console.warn('factory.box_checkpoint_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
      }
    }

    if (!usable) {
      // The Node is paused or this Server's container resources changed: the box stops and keeps its checkpoint.
      await this.stop(box, capabilities, state)
      if (state.lease) await this.sync(box, capabilities, state, { wake: false })
      return null
    }
    // Sync with the Server, as a paired Node does for all its boxes.
    const answer = await this.sync(box, capabilities, state)
    if (answer?.want === 'released') { await this.release(box.id, box); return null }
    if (!answer || answer.want === 'stopped') {
      await this.stop(box, capabilities, state)
      state.lease = undefined
      // Still waiting for a free box: ask again in case no stopping box wakes this one.
      return box.runId && box.runStatus === 'running' ? Date.now() + QUEUED_TICK_MS : null
    }

    // The box holds this lease now; an older one is taken over, its container kept.
    if (state.lease !== answer.lease) {
      state.lease = answer.lease
      if (state.ready) await this.intercept(box.id, answer.lease)
    }
    if (answer.cancelRunId && state.turn === answer.cancelRunId) await this.control({ op: 'cancel', runId: answer.cancelRunId }).catch(() => null)
    const offered = answer.turn?.runId
    const turn = offered && uuid(offered) && !state.handed.includes(offered) ? offered : null
    if (!state.ready) {
      if (!turn) {
        // Admitted with nothing to do: give the share back.
        await this.sync(box, capabilities, state)
        return null
      }
      try { await this.start(box, capabilities, state) }
      catch (error) {
        console.warn('factory.box_start_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' })
        if (container?.running) await container.destroy().catch(() => undefined)
        this.stopped(state)
        state.handed = [...state.handed, turn].slice(-KEPT_TURNS)
        await this.failTurn(turn, 'The Agent’s box could not start on Cloudflare. Check the Factory’s container and Artifacts access, then ask again.')
        await this.sync(box, capabilities, state, { reported: 'failed' })
        return null
      }
    }
    if (turn && !state.turn) await this.handTurn(box, state, turn)
    if (state.ready && (answer.review || answer.publish)) await this.outward(box, capabilities, state, answer)
    if (!state.turn && Date.now() - state.lastActive >= CLOUD_BOX_IDLE_MS) {
      await this.stop(box, capabilities, state)
      await this.sync(box, capabilities, state)
      return null
    }
    return Date.now() + CLOUD_BOX_TICK_MS
  }

  /**
   * Reports this box and renews its lease through the same sync and admission a paired Node uses. Boxes on
   * this Node that the sync admitted or released are woken, since no daemon tells them.
   */
  private async sync(box: CloudBox, capabilities: Capabilities, state: BoxState, { reported, wake = true }: { reported?: 'failed'; wake?: boolean } = {}) {
    const runtimeMs = Math.min(1e12, Math.floor((state.runtimeMs ?? 0) + (state.upSince ? Date.now() - state.upSince : 0)))
    const status = reported ?? (state.ready ? state.turn ? 'running' : 'idle' : 'stopped')
    const result = await syncBoxes(this.env, box.nodeId, { operation: 'sync', capacity: { ...capabilities.capacity, diskFree: capabilities.diskBytes },
      boxes: [{ id: box.id, lease: state.lease ?? NO_LEASE, state: status, ...(state.turn ? { runId: state.turn } : {}), runtimeMs }] })
    if (status === 'stopped' || status === 'failed') state.lease = undefined
    if (wake) for (const other of new Set([...result.admitted, ...result.released])) {
      if (other !== box.id) await wakeCloudBox(this.env, other).catch(() => undefined)
    }
    return result.boxes.find(entry => entry.id === box.id) ?? null
  }

  /** The outbound Worker for this box's lease, with the short storage or source grant a trusted helper needs. */
  private async intercept(boxId: string, lease: string, grant: Omit<BoxEgress, 'boxId' | 'lease'> = {}) {
    await this.ctx.container!.interceptOutboundHttps('*', this.ctx.exports.BoxOutbound({ props: { boxId, lease, ...grant } }))
  }

  /** One request to the box's control socket, through the same control.mjs a paired Node's daemon execs. */
  private async control(request: { op: 'health' } | { op: 'cancel'; runId: string } | { op: 'turn'; submission: unknown }) {
    const process = await this.ctx.container!.exec(['/usr/local/bin/node', '/opt/agent/src/control.mjs'], {
      user: '1000:1000', stdin: new Response(JSON.stringify(request)).body!, stdout: 'pipe', stderr: 'ignore', signal: AbortSignal.timeout(30000),
      env: { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', LLLL_BOX_SOCKET: '/run/l4/control.sock' },
    })
    return firstLine(process.stdout)
  }

  /** A trusted helper of the box image, run as the box's user: restore, bootstrap and checkpoint between turns, and a push's review or push. */
  private async command(input: unknown, processLimit: number, outputLimit = 400000) {
    const container = this.ctx.container!
    const process = await container.exec(['/usr/bin/prlimit', `--nproc=${processLimit}`, '--', '/usr/local/bin/node', '--input-type=module', '-e', cloudCodeBridge], {
      user: '1000:1000', stdin: new Response(JSON.stringify(input)).body!, stdout: 'pipe', stderr: 'pipe',
      env: { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', LLLL_BOX_ROOT: '/work', GIT_SSL_CAINFO: CA, NODE_EXTRA_CA_CERTS: CA },
    })
    const [output] = await Promise.all([readLimitedStream(process.stdout, outputLimit), discardDiagnostics(process.stderr)])
    if (!output.ok) throw new FactoryIoError('helper_stream_limit')
    if (await process.exitCode !== 0) throw new FactoryIoError('helper_exit')
    try { return JSON.parse(new TextDecoder().decode(output.bytes)) }
    catch { throw new FactoryIoError('helper_json') }
  }

  /**
   * Starts the box's container under its lease and gives it the Task's checkout: restored from the last
   * acknowledged checkpoint, or cloned from the pinned source on the box's first start.
   */
  private async start(box: CloudBox, capabilities: Capabilities, state: BoxState) {
    const container = this.ctx.container!, lease = state.lease!
    if (container.running) await container.destroy()
    await this.intercept(box.id, lease)
    // The released image's supervisor runs as root; the box runtime and everything the Agent starts run as uid 1000.
    container.start({ enableInternet: false,
      entrypoint: ['/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--no-new-privs', '/usr/bin/prlimit', `--nproc=${capabilities.processLimit}`, '--', '/usr/local/bin/node', '/opt/agent/src/box.mjs'],
      env: { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', LLLL_BOX_ROOT: '/work', LLLL_BOX_SOCKET: '/run/l4/control.sock', NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA } })
    state.upSince = Date.now()
    // A backstop only: this object stops the box itself when it is idle, and every sync's health check keeps it awake.
    await container.setInactivityTimeout(CLOUD_BOX_IDLE_MS + 60000)
    for (let attempt = 0; ; attempt++) {
      const health = await this.control({ op: 'health' }).catch(() => null)
      if (health?.status === 'ready') break
      if (attempt >= 20) throw new Error('The box did not become ready')
      await scheduler.wait(500)
    }
    if (!factoryImageAccepted((await container.inspect())?.image, capabilities.image)) throw new Error('Running container image differs from the approved digest')
    const checkpoint = await this.ctx.storage.get<Checkpoint>('checkpoint')
    if (checkpoint) await this.restore(box, capabilities, lease, checkpoint)
    else await this.bootstrap(box, capabilities, lease)
    if ((await this.control({ op: 'health' }))?.checkout !== true) throw new Error('The box has no checkout')
    state.ready = true
    state.dirty = false
    state.lastActive = Date.now()
  }

  private async repository(boxId: string) {
    return factoryRepositoryName(await getServerId(this.env.DB), boxId)
  }

  /** The first start: the pinned source through a single-repository read grant, then the Task's own Artifacts repository. */
  private async bootstrap(box: CloudBox, capabilities: Capabilities, lease: string) {
    const environment = JSON.parse(box.environmentJson) as RunEnvironment
    const gitea = environment.provider === 'gitea', inL4 = environment.provider === 'artifacts'
    let sourceToken: string | undefined, project: ArtifactsGrant | undefined
    try {
      // Gitea credentials stay in the outbound Worker; the container receives only the clone address. A Project's
      // repository in L4 is read with a short token of its own, which also stays in the outbound Worker.
      if (inL4) project = await artifactsGrant(this.env, environment.sourceRepo, 'read', 180)
      const remote = project ? project.remote : gitea ? await giteaRemote(this.env, environment.gitConnectionId, environment.sourceRepo) : `https://github.com/${environment.sourceRepo}.git`
      if (!gitea && !inL4) {
        const grant = await computeBoxSource(this.env, box.nodeId, { operation: 'source', boxId: box.id, lease })
        sourceToken = 'sourceToken' in grant ? grant.sourceToken : undefined
        if (!sourceToken) throw new Error('Source grant unavailable')
      }
      await this.intercept(box.id, lease, { source: { remote, token: project?.token ?? sourceToken ?? 'gitea-broker' } })
      const cloned = await this.command({ operation: 'bootstrap', remote, baseSha: environment.baseSha }, capabilities.processLimit)
      if (!cloned.ok) throw new Error('Source bootstrap failed')
    } finally {
      await this.intercept(box.id, lease)
      if (project) await project.revoke()
      if (sourceToken) await fetch('https://api.github.com/installation/token', { method: 'DELETE', headers: { Authorization: `Bearer ${sourceToken}`, 'User-Agent': 'L4-Factory' }, redirect: 'manual' }).catch(() => undefined)
    }
    const code = this.env.FACTORY_CODE!, repository = await this.repository(box.id)
    // A repository left by a first start that never acknowledged a checkpoint holds nothing acknowledged.
    let created: Awaited<ReturnType<typeof code.create>>
    try { created = await code.create(repository, { description: `L4 private Task ${box.taskId}`, setDefaultBranch: 'l4-state' }) }
    catch { await code.delete(repository).catch(() => undefined); created = await code.create(repository, { description: `L4 private Task ${box.taskId}`, setDefaultBranch: 'l4-state' }) }
    const repo = await code.get(repository)
    try { await repo.revokeToken(created.token) } finally { repo[Symbol.dispose]() }
  }

  private async restore(box: CloudBox, capabilities: Capabilities, lease: string, checkpoint: Checkpoint) {
    const repository = await this.repository(box.id)
    if (checkpoint.repository !== repository || checkpoint.image !== capabilities.image) throw new Error('Checkpoint or image recovery needs inspection')
    const repo = await this.env.FACTORY_CODE!.get(repository)
    const tokens: string[] = []
    try {
      const info = await repo.info(), token = await repo.createToken('read', 180)
      tokens.push(token.id)
      await this.intercept(box.id, lease, { storage: { remote: info.remote, token: token.plaintext, write: false } })
      const restored = await this.command({ operation: 'restore', remote: info.remote, checkpoint: checkpoint.sha, baseSha: (JSON.parse(box.environmentJson) as RunEnvironment).baseSha }, capabilities.processLimit)
      if (!restored.ok) throw new Error('Acknowledged code could not be restored')
    } finally {
      await this.intercept(box.id, lease)
      for (const token of tokens) await repo.revokeToken(token).catch(() => undefined)
      repo[Symbol.dispose]()
    }
  }

  /** Saves the box's work to its Artifacts repository. Only between turns, so nothing of a turn races it. */
  private async checkpoint(box: CloudBox, capabilities: Capabilities, state: BoxState) {
    if (!state.ready || state.turn || !state.dirty || !state.lease) return
    const repository = await this.repository(box.id), previous = await this.ctx.storage.get<Checkpoint>('checkpoint')
    const repo = await this.env.FACTORY_CODE!.get(repository)
    const tokens: string[] = []
    try {
      const info = await repo.info(), token = await repo.createToken('write', 180)
      tokens.push(token.id)
      await this.intercept(box.id, state.lease, { storage: { remote: info.remote, token: token.plaintext, write: true } })
      const stored = await this.command({ operation: 'checkpoint', remote: info.remote, checkpoint: previous?.sha, baseSha: (JSON.parse(box.environmentJson) as RunEnvironment).baseSha }, capabilities.processLimit)
      if (!stored.ok || !/^[a-f0-9]{40}$/u.test(stored.checkpoint)) throw new Error('Checkpoint was not acknowledged')
      await this.ctx.storage.put('checkpoint', { sha: stored.checkpoint, repository, image: capabilities.image, updatedAt: nowIso() } satisfies Checkpoint)
      state.dirty = false
      await this.env.DB.prepare('UPDATE factory_boxes SET checkpoint_sha=?,head_sha=?,updated_at=? WHERE id=?').bind(stored.checkpoint, /^[a-f0-9]{40}$/u.test(stored.head) ? stored.head : null, nowIso(), box.id).run()
    } finally {
      await this.intercept(box.id, state.lease)
      for (const token of tokens) await repo.revokeToken(token).catch(() => undefined)
      repo[Symbol.dispose]()
    }
  }

  /**
   * The box's pushes, as its sync says: the review a person reads of one, or the approved one to push. The
   * Agent's turn waits on its tool call meanwhile, so this runs while the turn does.
   */
  private async outward(box: CloudBox, capabilities: Capabilities, state: BoxState, answer: { review?: { approvalId: string; sha: string; baseSha: string }; publish?: { approvalId: string; sha: string; ref: string; baseSha: string; direct?: true } }) {
    const failed = (value: unknown, fallback: string) => String((value as { message?: unknown } | null)?.message ?? fallback).slice(0, 300)
    if (answer.review) {
      const { approvalId, sha, baseSha } = answer.review
      const made = await this.command({ operation: 'review', sha, baseSha }, capabilities.processLimit, 2_600_000).catch(() => null) as { ok?: boolean; review?: unknown } | null
      const body = made?.ok ? { ok: true, review: made.review } : { ok: false, message: failed(made, 'The commit could not be reviewed') }
      await submitReview(this.env, box.nodeId, approvalId, new TextEncoder().encode(JSON.stringify(body)))
        .catch(error => console.warn('factory.box_review_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
    }
    if (!answer.publish) return
    const { approvalId } = answer.publish
    let claim: Awaited<ReturnType<typeof claimPublication>>
    try { claim = await claimPublication(this.env, box.nodeId, approvalId) } catch { return }
    const environment = claim.environment
    let token: string | undefined, project: ArtifactsGrant | undefined, ok = false, message: string | undefined
    try {
      const gitea = environment.provider === 'gitea'
      // Gitea credentials stay in the outbound Worker; a GitHub token lives only in its grant for this push, and so
      // does the short write token of a Project's repository in L4 (ADR 0013).
      if (environment.provider === 'artifacts') project = await artifactsGrant(this.env, environment.sourceRepo, 'write', 180)
      const remote = project ? project.remote : gitea ? await giteaRemote(this.env, environment.gitConnectionId, environment.sourceRepo) : `https://github.com/${environment.sourceRepo}.git`
      if (!gitea && !project) token = await githubPushGrant(this.env, { connectionId: environment.gitConnectionId, installationId: environment.sourceInstallationId, repositoryId: environment.sourceRepoId }, claim.ensure)
      // A base branch (direct_push) moves only forward from the head the Server read for this push.
      const direct = claim.direct ? { direct: true as const, old: claim.expectedOld! } : {}
      await this.intercept(box.id, state.lease!, { push: { remote, token: project?.token ?? token ?? 'gitea-broker', ref: claim.ref, sha: claim.request.sha, ...direct } })
      const pushed = await this.command({ operation: 'publish', remote, ref: claim.ref, sha: claim.request.sha, baseSha: environment.baseSha, expectedOld: claim.expectedOld,
        ...(claim.direct ? { fastForward: true } : {}) }, capabilities.processLimit) as { ok?: boolean }
      ok = pushed.ok === true
      if (!ok) message = failed(pushed, 'The repository refused the push')
    } catch { message = 'The push failed' }
    finally {
      await this.intercept(box.id, state.lease!).catch(() => undefined)
      if (project) await project.revoke()
      if (token) await revokeGithubToken(token, 'L4-Factory')
      await publishedApproval(this.env, box.nodeId, approvalId, { ok, ...(message ? { message } : {}) })
        .catch(error => console.warn('factory.box_publish_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
    }
  }

  /** Hands the Run's turn to the box. It is recorded first, so a turn is never handed twice. */
  private async handTurn(box: CloudBox, state: BoxState, runId: string) {
    let submission: unknown
    try { ({ submission } = await computeTurn(this.env, box.nodeId, { operation: 'turn', boxId: box.id, lease: state.lease!, runId })) }
    catch (error) {
      // The Run has not handed over its turn yet: the next sync asks again.
      if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 409) return
      throw error
    }
    state.handed = [...state.handed ?? [], runId].slice(-KEPT_TURNS)
    state.turn = runId
    state.dirty = true
    await this.ctx.storage.put('box', state)
    const answer = await this.control({ op: 'turn', submission }).catch(() => null)
    if (answer?.accepted !== true) {
      state.turn = undefined
      await this.failTurn(runId, 'The Agent’s box refused this turn. Ask again.')
    }
  }

  /** Ends a Run's turn that its box cannot finish, so the conversation hears why instead of waiting. */
  private async failTurn(runId: string, message: string) {
    await boxRun(this.env, runId).boxEvents(runId, 0, [], { type: 'error', message } satisfies RuntimeEvent).catch(() => undefined)
  }

  private stopped(state: BoxState) {
    if (state.upSince) state.runtimeMs = (state.runtimeMs ?? 0) + Date.now() - state.upSince
    state.upSince = undefined
    state.ready = false
  }

  /** Checkpoints work not yet saved, then stops the container. Its checkpoint stays until the Task is Done. */
  private async stop(box: CloudBox, capabilities: Capabilities, state: BoxState) {
    const container = this.ctx.container
    if (state.turn) {
      const lost = state.turn
      state.turn = undefined
      await this.failTurn(lost, 'The Agent’s box stopped during this turn. Ask again to continue.')
    }
    if (state.ready && container?.running) await this.checkpoint(box, capabilities, state).catch(error => console.warn('factory.box_checkpoint_failed', { boxId: box.id, error: error instanceof Error ? error.message : 'failed' }))
    if (container?.running) await container.destroy()
    this.stopped(state)
  }

  /** The Task is Done or the box is gone: its container and its Artifacts repository go with it. */
  private async release(boxId: string, box: CloudBox | null) {
    if (this.ctx.container?.running) await this.ctx.container.destroy()
    if (box || await this.ctx.storage.get('checkpoint')) await this.env.FACTORY_CODE?.delete(await this.repository(boxId)).catch(() => undefined)
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }
}
