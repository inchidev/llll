import type {} from '../types/agent-exports'
import { DurableObject } from 'cloudflare:workers'
import type { L4Env } from './env'
import { cloudflareCapabilities } from '../shared/software-factory'
import { actionColumns, authorizeFactoryAction, type ActionRow } from '../server/utils/factory-actions'
import { computePoll, computePollSchema } from '../server/utils/compute-nodes'
import { readLimitedStream } from './inbound-email-signature'
import { getServerId } from '../shared/server-id'
import { nowIso } from '../shared/ids'

type Receipt = Extract<ReturnType<typeof computePollSchema.parse>, { operation: 'result' }>
type Checkpoint = { sha: string; repository: string; image: string; updatedAt: string }
/** One DO and one private code repository per Task workspace. No HTTP workspace port is exposed. */
export class FactoryComputeDurableObject extends DurableObject<L4Env> {
  override async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).pathname.slice(1)
    if (id === 'state' && request.method === 'GET' && this.env.FACTORY_COMPUTE) {
      const workspaceId = new URL(request.url).searchParams.get('workspace') ?? ''
      if (!/^[a-f0-9-]{36}$/u.test(workspaceId) || !this.ctx.id.equals(this.env.FACTORY_COMPUTE.idFromName(`workspace:${workspaceId}`))) return new Response('Invalid workspace scope', { status: 403 })
      return Response.json({ checkpoint: await this.ctx.storage.get('checkpoint') ?? null, recovery: await this.ctx.storage.get('receipt') ? 'receipt_pending' : await this.ctx.storage.get('started') ? 'executing' : 'idle' })
    }
    if (id === 'probe' && request.method === 'POST' && this.env.FACTORY_COMPUTE && this.ctx.container) {
      const expected = this.env.FACTORY_COMPUTE.idFromName(`probe:${await getServerId(this.env.DB)}`)
      if (!this.ctx.id.equals(expected)) return new Response('Invalid probe scope', { status: 403 })
      const container = this.ctx.container
      try {
        if (container.running) await container.destroy()
        container.start({ entrypoint: ['/bin/sleep', 'infinity'], enableInternet: false })
        await container.setInactivityTimeout(1000)
        for (let attempt = 0; ; attempt++) {
          try { const process = await container.exec(['/usr/local/bin/node', '-e', 'if(process.getuid()!==1000)process.exit(1)'], { user: '1000:1000', stdout: 'ignore', stderr: 'ignore' }); if (await process.exitCode !== 0) throw new Error('Image user mismatch'); break }
          catch (error) { if (attempt >= 60) throw error; await scheduler.wait(500) }
        }
        const running = await container.inspect()
        if (!running || running.image !== this.env.FACTORY_IMAGE) throw new Error('Released container image mismatch')
        return Response.json({ ready: true })
      } finally { if (container.running) await container.destroy() }
    }
    if (request.method !== 'POST' || !/^[a-f0-9-]{36}$/u.test(id)) return new Response('Invalid action', { status: 400 })
    const row = await this.env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=?`).bind(id).first<ActionRow>()
    if (!row) return new Response('Unknown action', { status: 404 })
    const context = await authorizeFactoryAction(this.env, row)
    if (!this.env.FACTORY_COMPUTE || !this.ctx.id.equals(this.env.FACTORY_COMPUTE.idFromName(`workspace:${context.workspace.id}`))) return new Response('Workspace scope mismatch', { status: 403 })
    cloudflareCapabilities.parse(context.capabilities)
    const active = await this.ctx.storage.get<string>('action')
    if (active === id && await this.ctx.storage.get<boolean>('started')) return new Response(null, { status: 202 })
    if (active && active !== id) {
      const previous = await this.env.DB.prepare('SELECT status FROM factory_actions WHERE id=?').bind(active).first<{ status: string }>()
      if (await this.ctx.storage.get('started') || await this.ctx.storage.get('receipt') || previous && ['pending', 'approved', 'claimed', 'executing'].includes(previous.status)) return new Response('Workspace is busy', { status: 409 })
      await this.clearQueuedAction(active)
    }
    await this.ctx.storage.put('action', id)
    await this.ctx.storage.setAlarm(Date.now() + 1)
    return new Response(null, { status: 202 })
  }

  private async clearQueuedAction(actionId: string) {
    await this.ctx.storage.transaction(async transaction => {
      if (await transaction.get<string>('action') === actionId) await transaction.delete('action')
    })
  }

  private async command(script: string, input: unknown, limit = 400000, processLimit = 128) {
    const container = this.ctx.container!
    const process = await container.exec(['/usr/bin/prlimit', `--nproc=${processLimit}`, '--', '/usr/local/bin/node', `/opt/l4/${script}`], {
      user: '1000:1000', stdin: new Response(JSON.stringify(input)).body!, stderr: 'combined',
      env: { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', GIT_SSL_CAINFO: '/etc/cloudflare/certs/cloudflare-containers-ca.crt', NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' },
    })
    const output = await readLimitedStream(process.stdout, limit)
    if (!output.ok || await process.exitCode !== 0) throw new Error('Container output or execution limit reached')
    return JSON.parse(new TextDecoder().decode(output.bytes))
  }

  override async alarm(): Promise<void> {
    const actionId = await this.ctx.storage.get<string>('action')
    if (!actionId) return
    const row = await this.env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=?`).bind(actionId).first<ActionRow>()
    if (!row) { if (this.ctx.container?.running) await this.ctx.container.destroy(); await this.ctx.storage.delete(['action', 'started']); return }
    const nodeId = await this.ctx.storage.get<string>('nodeId')
    const receipt = await this.ctx.storage.get<Receipt>('receipt')
    if (receipt && nodeId) {
      await computePoll(this.env, nodeId, receipt)
      await this.ctx.storage.delete(['action', 'receipt', 'started'])
      return
    }
    if (await this.ctx.storage.get<boolean>('started')) {
      // A lost process can have effects. Never restart its command or checkpoint push.
      if (this.ctx.container?.running) await this.ctx.container.destroy()
      await this.env.DB.prepare("UPDATE factory_actions SET status='uncertain' WHERE id=? AND status IN ('claimed','executing')").bind(actionId).run()
      await this.ctx.storage.delete(['action', 'started'])
      return
    }
    if (row.status !== 'approved') { await this.clearQueuedAction(actionId); return }
    let context: Awaited<ReturnType<typeof authorizeFactoryAction>>
    try { context = await authorizeFactoryAction(this.env, row) }
    catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error && [403, 404, 409].includes(Number(error.statusCode))) { await this.clearQueuedAction(actionId); return }
      throw error
    }
    const capabilities = cloudflareCapabilities.parse(context.capabilities)
    if (!this.env.FACTORY_CODE || !this.ctx.container || capabilities.image !== this.env.FACTORY_IMAGE) throw new Error('Factory resources or pinned image unavailable')
    const claimed = await computePoll(this.env, context.workspace.nodeId, { operation: 'claim' }, actionId)
    if (!claimed.job) { await this.ctx.storage.setAlarm(Date.now() + 3000); return }
    const claim = claimed.job
    await this.ctx.storage.put({ started: true, nodeId: context.workspace.nodeId })
    // An alarm left behind by process loss observes uncertainty instead of executing again.
    await this.ctx.storage.setAlarm(Date.now() + 15000)
    const job = await computePoll(this.env, context.workspace.nodeId, { operation: 'begin', ...claim })
    if (!('request' in job)) throw new Error('Invalid Factory claim')
    const container = this.ctx.container
    const started = Date.now()
    let checkpoint = await this.ctx.storage.get<Checkpoint>('checkpoint')
    const repository = `l4-${context.auth.serverId.replaceAll('-', '')}-${context.workspace.id.replaceAll('-', '')}`
    const sourceToken = 'sourceToken' in job ? job.sourceToken : undefined
    const tokens: string[] = []
    let repo: ArtifactsRepo | undefined
    const heartbeat = setInterval(() => {
      void computePoll(this.env, context.workspace.nodeId, { operation: 'heartbeat', ...claim }).then(() => this.ctx.storage.setAlarm(Date.now() + 15000)).catch(() => container.destroy()).catch(() => undefined)
    }, 3000)
    const deadline = setTimeout(() => { void container.destroy().catch(() => undefined) }, job.executionBudgetMs)
    try {
      if (context.request.operation === 'release') {
        if (checkpoint) await this.env.FACTORY_CODE.delete(repository)
        await this.ctx.storage.delete('checkpoint')
        checkpoint = undefined
      } else {
        if (container.running) await container.destroy()
        // Default policy enforces non-root permissions; this released image is reset for every operation.
        container.start({ entrypoint: ['/bin/sleep', 'infinity'], enableInternet: false })
        await container.setInactivityTimeout(1000)
        for (let attempt = 0; ; attempt++) {
          try { const probe = await container.exec(['/usr/local/bin/node', '--version'], { user: '1000:1000', stdout: 'ignore', stderr: 'ignore' }); await probe.exitCode; break }
          catch (error) { if (attempt >= 60) throw error; await scheduler.wait(500) }
        }
        const running = await container.inspect()
        if (!running || running.image !== capabilities.image) throw new Error('Running container image differs from the approved digest')
        const phase = async (kind: 'source' | 'restore' | 'command' | 'checkpoint', remote?: string, token?: string) => {
          await container.interceptOutboundHttps('*', this.ctx.exports.FactoryOutbound({ props: { actionId, lease: claim.lease, phase: kind, remote, token } }))
        }
        if (context.request.operation === 'bootstrap') {
          if (checkpoint) throw new Error('Workspace already has acknowledged code')
          const source = `https://github.com/${context.environment.sourceRepo}.git`
          await phase('source', source, sourceToken)
          const restored = await this.command('cloud-io.mjs', { operation: 'bootstrap', remote: source, baseSha: job.baseSha }, 400000, capabilities.processLimit)
          if (!restored.ok) throw new Error('Source bootstrap failed')
          const created = await this.env.FACTORY_CODE.create(repository, { description: `L4 private Task ${context.workspace.taskId}`, setDefaultBranch: 'l4-state' })
          repo = await this.env.FACTORY_CODE.get(repository)
          await repo.revokeToken(created.token)
        } else {
          if (!checkpoint || checkpoint.repository !== repository || checkpoint.image !== capabilities.image) throw new Error('Checkpoint or image recovery needs inspection')
          repo = await this.env.FACTORY_CODE.get(repository)
          const info = await repo.info(), token = await repo.createToken('read', 180)
          tokens.push(token.id)
          await phase('restore', info.remote, token.plaintext)
          const restored = await this.command('cloud-io.mjs', { operation: 'restore', remote: info.remote, checkpoint: checkpoint.sha, baseSha: job.baseSha }, 400000, capabilities.processLimit)
          await repo.revokeToken(token.id)
          if (!restored.ok) throw new Error('Acknowledged code could not be restored')
        }
        await phase('command')
      }
      let result: { ok: boolean; exitCode: number; output: string; runtimeMs?: number; snapshot?: unknown } = context.request.operation === 'bootstrap'
        ? { ok: true, exitCode: 0, output: `Pinned checkout ${job.baseSha}` }
        : context.request.operation === 'release' ? { ok: true, exitCode: 0, output: 'Task code repository explicitly released' }
          : await this.command('operate.mjs', { request: context.request, baseSha: job.baseSha }, 400000, capabilities.processLimit)
      if (context.request.operation !== 'release') {
        const stop = await container.exec(['/usr/bin/pkill', '-KILL', '-u', '1000'], { user: '0:0', stdout: 'ignore', stderr: 'ignore' }); await stop.exitCode
        if (!repo) throw new Error('Private code repository unavailable')
        const info = await repo.info(), token = await repo.createToken('write', 180)
        tokens.push(token.id)
        await container.interceptOutboundHttps('*', this.ctx.exports.FactoryOutbound({ props: { actionId, lease: claim.lease, phase: 'checkpoint', remote: info.remote, token: token.plaintext } }))
        const stored = await this.command('cloud-io.mjs', { operation: 'checkpoint', remote: info.remote, checkpoint: checkpoint?.sha, baseSha: job.baseSha }, 400000, capabilities.processLimit)
        if (!stored.ok || !/^[a-f0-9]{40}$/u.test(stored.checkpoint)) throw new Error('Checkpoint was not acknowledged')
        checkpoint = { sha: stored.checkpoint, repository, image: capabilities.image, updatedAt: nowIso() }
        await this.ctx.storage.put('checkpoint', checkpoint)
      }
      result = { ...result, runtimeMs: Math.min(900000, Date.now() - started) }
      const saved = computePollSchema.parse({ operation: 'result', ...claim, result })
      if (saved.operation !== 'result') throw new Error('Invalid receipt')
      await this.ctx.storage.put('receipt', saved)
      await computePoll(this.env, context.workspace.nodeId, saved)
      await this.ctx.storage.delete(['action', 'receipt', 'started'])
    } catch {
      if (await this.ctx.storage.get('receipt')) { await this.ctx.storage.setAlarm(Date.now() + 3000); return }
      await this.env.DB.prepare("UPDATE factory_actions SET status='uncertain',result_json=? WHERE id=? AND status IN ('claimed','executing')")
        .bind(JSON.stringify({ message: 'Execution or durable code checkpoint could not be confirmed. The last acknowledged checkpoint is retained; inspect capacity, provider availability and interrupted effects. This command will not be replayed.', checkpoint: checkpoint?.sha ?? null }), actionId).run()
      await this.ctx.storage.delete(['action', 'started'])
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline)
      if (container.running) await container.destroy()
      if (repo) {
        for (const token of tokens) await repo.revokeToken(token).catch(() => undefined)
        repo[Symbol.dispose]()
      }
      if (sourceToken) {
        await fetch('https://api.github.com/installation/token', { method: 'DELETE', headers: { Authorization: `Bearer ${sourceToken}`, 'User-Agent': 'L4-Factory' }, redirect: 'manual' }).catch(() => undefined)
      }
    }
  }
}
