import { WorkerEntrypoint } from 'cloudflare:workers'
import type { L4Env } from './env'
import type { RunEnvironment } from '../shared/code-environments'
import { AGENT_GATEWAY_PATH, agentGateway } from '../server/utils/agent-gateway'
import { leasedCloudBox } from '../server/utils/factory-boxes'
import { giteaPush, giteaRemote, giteaSourceFetch } from '../server/utils/gitea'
import { inspectReceivePack, ownBranchRef } from '../shared/git-pktline'
import { boxEgress, EGRESS_BODY_LIMIT, egressBytes, egressSecretValues, markSecretsUsed, replacePlaceholders, scrubStream, scrubText, TEXT_BODY, type CompiledEgress } from '../server/utils/box-egress'

/** Reads a body up to `limit`; past it, what was read and the rest stream on unchanged. */
async function readPrefix(body: ReadableStream<Uint8Array>, limit: number): Promise<{ bytes: Uint8Array } | { stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); size += value.byteLength
    if (size > limit) {
      return { stream: new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk) },
        async pull(controller) { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value) },
        cancel(reason) { return reader.cancel(reason) },
      }) }
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { bytes }
}

/**
 * What one Cloudflare box may reach, set by its Durable Object. The lease is checked against the Server's
 * factory_boxes on every request, so a box that lost it reaches nothing, whatever the props still say.
 */
export type BoxEgress = { boxId: string; lease: string
  /** The Task's own Artifacts repository, with a short token, while a trusted helper restores or checkpoints it. */
  storage?: { remote: string; token: string; write: boolean }
  /** The original repository's pinned source, read once while the box's first checkout is cloned. */
  source?: { remote: string; token: string }
  /**
   * One approved push to the original repository, while a trusted helper makes it: the Task's own branch, or
   * under a direct_push Git flow the base branch, then only from `old`, the head the Server read for it.
   */
  push?: { remote: string; token: string; ref: string; sha: string; direct?: true; old?: string } }

/** A Git smart-HTTP request under `remote` for one service only: its refs advertisement or the service itself. */
function gitService(url: URL, request: Request, remote: URL, service: 'git-upload-pack' | 'git-receive-pack') {
  if (url.origin !== remote.origin || !url.pathname.startsWith(remote.pathname)) return null
  const suffix = url.pathname.slice(remote.pathname.length)
  const allowed = request.method === 'GET' && suffix === '/info/refs' && url.searchParams.get('service') === service
    || request.method === 'POST' && suffix === `/${service}` && !url.search
  return allowed ? suffix : null
}

/**
 * The box's only way out. Credentials are added here, never inside the box: the box holds only its Run's
 * gateway capability and placeholders. Beyond the gateway and a trusted helper's Git grant, the box reaches
 * only the hosts its Project and open windows allow (server/utils/box-egress.ts); everything else is refused.
 */
export class BoxOutbound extends WorkerEntrypoint<L4Env, BoxEgress> {
  override async fetch(request: Request): Promise<Response> {
    const grant = this.ctx.props
    const box = await leasedCloudBox(this.env, grant.boxId, grant.lease)
    if (!box) return new Response('Box authorization expired', { status: 403 })
    const url = new URL(request.url), headers = new Headers(request.headers)
    // What the box itself sent, for a host its network opens: its own headers, credentials only as placeholders.
    const sent = new Headers(request.headers)
    headers.delete('cookie')
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return new Response('HTTPS destination required', { status: 403 })

    // The Server's gateway, served inside this Worker as the Run's Durable Object serves embedded Pi: a
    // request to the public address can be routed elsewhere, such as a Preview's parent Worker.
    const servers = [this.env.AGENT_CALLBACK_ORIGIN, this.env.PUBLIC_ORIGIN].flatMap(origin => { try { return origin ? [new URL(origin).hostname] : [] } catch { return [] } })
    const gateway = servers.includes(url.hostname) && !url.search ? url.pathname.match(AGENT_GATEWAY_PATH) : null
    if (gateway) {
      // Only a Run of this box's Task, Agent and initiator; the gateway itself checks the Run's capability.
      const own = await this.env.DB.prepare('SELECT 1 FROM agent_runs WHERE id=? AND task_id=? AND agent_id=? AND initiated_by=?').bind(gateway[1]!, box.taskId, box.agentId, box.initiatedBy).first()
      if (!own) return new Response('Run is not this box’s', { status: 403 })
      return agentGateway(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual' }), this.env, gateway[1]!, gateway[2]!, promise => this.ctx.waitUntil(promise))
    }

    headers.delete('authorization')
    if (grant.storage) {
      const remote = new URL(grant.storage.remote)
      if (gitService(url, request, remote, grant.storage.write ? 'git-receive-pack' : 'git-upload-pack') !== null) {
        headers.set('authorization', `Bearer ${grant.storage.token}`)
        return this.forward(url, request, headers)
      }
    }
    if (grant.source) {
      const remote = new URL(grant.source.remote)
      const suffix = gitService(url, request, remote, 'git-upload-pack')
      if (suffix !== null) {
        const environment = JSON.parse(box.environmentJson) as RunEnvironment
        if (environment.provider === 'gitea') {
          if (remote.href !== await giteaRemote(this.env, environment.gitConnectionId, environment.sourceRepo)) return new Response('Repository capability denied', { status: 403 })
          return giteaSourceFetch(this.env, environment.gitConnectionId, environment.sourceRepo, suffix, request)
        }
        if (remote.href !== `https://github.com/${environment.sourceRepo}.git`) return new Response('Repository capability denied', { status: 403 })
        headers.set('authorization', 'Basic ' + btoa(`x-access-token:${grant.source.token}`))
        return this.forward(url, request, headers)
      }
    }
    if (grant.push) {
      // Only `<old> <approved sha> <the approved branch>`: the commands are read before anything is forwarded.
      const remote = new URL(grant.push.remote)
      const suffix = gitService(url, request, remote, 'git-receive-pack')
      if (suffix !== null) {
        const environment = JSON.parse(box.environmentJson) as RunEnvironment
        // A base branch only as a fast-forward from the head the Server read; otherwise the box's own branch.
        const direct = grant.push.direct === true
        if (direct ? grant.push.ref !== `refs/heads/${environment.baseBranch}` || !/^[a-f0-9]{40}$/u.test(grant.push.old ?? '') : !ownBranchRef(grant.push.ref, box.id)) return new Response('Only the Task’s own branch may be pushed', { status: 403 })
        const expected = { ref: grant.push.ref, sha: grant.push.sha, ...(direct ? { old: grant.push.old! } : {}) }
        if (environment.provider === 'gitea') {
          if (remote.href !== await giteaRemote(this.env, environment.gitConnectionId, environment.sourceRepo)) return new Response('Repository capability denied', { status: 403 })
          return giteaPush(this.env, environment.gitConnectionId, environment.sourceRepo, suffix, request, expected)
        }
        if (remote.href !== `https://github.com/${environment.sourceRepo}.git`) return new Response('Repository capability denied', { status: 403 })
        let body: ReadableStream<Uint8Array> | null = null
        if (request.method === 'POST') {
          if (![null, 'identity'].includes(request.headers.get('content-encoding'))) return new Response('Compressed pushes are not accepted', { status: 403 })
          const inspected = await inspectReceivePack(request.body, expected)
          if ('refusal' in inspected) return new Response(inspected.refusal, { status: 403 })
          body = inspected.body
        }
        headers.set('authorization', 'Basic ' + btoa(`x-access-token:${grant.push.token}`))
        return this.forward(url, request, headers, body)
      }
    }
    // The Project's network and the Task's open windows, as the box's sync compiles them for a VPS Node too.
    // This Server is reached only through its gateway above.
    const egress = (await boxEgress(this.env, [box.id])).get(box.id)
    if (!egress || !egress.hosts.includes(url.hostname) || servers.includes(url.hostname)) {
      return new Response(`${url.hostname} is not open for this box. Ask with request_network_window.`, { status: 403 })
    }
    return this.window(url, request, sent, egress)
  }

  /**
   * A request to an open host. Each placeholder in effect there becomes its value in the URL, the headers and
   * a text body up to 1 MB; a known placeholder that is not refuses the request with the reason. The answer
   * has the values taken out again.
   */
  private async window(url: URL, request: Request, sent: Headers, egress: CompiledEgress) {
    const host = url.hostname
    const values = egress.secretHosts.includes(host) ? await egressSecretValues(this.env, egress, host) : []
    const refuse = (message: string) => new Response(message, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    const target = replacePlaceholders(url.pathname + url.search, host, values, egress.known, 'url')
    if ('refused' in target) return refuse(target.refused)
    let changed = target.changed
    const headers = new Headers()
    for (const [key, value] of sent) {
      if (['host', 'content-length', 'accept-encoding'].includes(key)) continue
      const replaced = replacePlaceholders(value, host, values, egress.known)
      if ('refused' in replaced) return refuse(replaced.refused)
      changed ||= replaced.changed
      headers.set(key, replaced.text)
    }
    // Uncompressed answers, so a value an answer repeats can be taken out of it.
    if (values.length) headers.set('accept-encoding', 'identity')
    let body: BodyInit | null = null
    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      const read = await readPrefix(request.body, EGRESS_BODY_LIMIT)
      const encoded = ![null, 'identity'].includes(sent.get('content-encoding')), type = sent.get('content-type')
      if ('bytes' in read && !encoded && (!type || TEXT_BODY.test(type))) {
        const replaced = replacePlaceholders(egressBytes.text(read.bytes), host, values, egress.known, 'body')
        if ('refused' in replaced) return refuse(replaced.refused)
        changed ||= replaced.changed
        body = egressBytes.bytes(replaced.text)
      } else body = 'bytes' in read ? read.bytes as Uint8Array<ArrayBuffer> : read.stream
    }
    if (changed && values.length) this.ctx.waitUntil(markSecretsUsed(this.env, values.map(value => value.id)))
    const response = await fetch(new Request(new URL(target.text, url.origin), { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(120000),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit))
    if (!values.length) return response
    const answer = new Headers()
    for (const [key, value] of response.headers) if (key !== 'content-length') answer.append(key, scrubText(value, values))
    return new Response(response.body ? response.body.pipeThrough(scrubStream(values)) : null, { status: response.status, statusText: response.statusText, headers: answer })
  }

  private async forward(url: URL, request: Request, headers: Headers, body: ReadableStream<Uint8Array> | null = request.body) {
    const response = await fetch(new Request(url, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(120000), ...(body ? { duplex: 'half' } : {}) } as RequestInit))
    // A redirect never forwards a credential or leaves the granted destination.
    if (response.status >= 300 && response.status < 400) return new Response('Redirect denied', { status: 502 })
    return response
  }
}
