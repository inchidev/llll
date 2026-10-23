import { OpenCodeWorkerd } from '@opencode/sdk/workerd'

/** Isolated acceptance Worker. It is not imported by the L4 Server or Shell. */
export class OpenCodeProbe {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.host = ctx.blockConcurrencyWhile(async () => {
      this.job = await ctx.storage.get('job')
      this.modelCalls = (await ctx.storage.get('modelCalls')) ?? 0
      return OpenCodeWorkerd.create({
        storage: ctx.storage, app: { name: 'l4', version: '2.1.4', channel: 'oss' },
        config: { plugins: [] }, models: { fetch: false }, log: { level: 'error' },
        plugins: [{ id: 'l4-acceptance', setup: async plugin => {
          await plugin.tool.transform(tools => {
            for (const [name, description, input] of [
              ['list_tasks', 'Read the tasks available to the current L4 Run.', { type: 'object', properties: {} }],
              ['create_task', 'Create one task on the allowed board.', { type: 'object', properties: { boardId: { type: 'string' }, title: { type: 'string' } }, required: ['boardId', 'title'] }],
            ]) tools.add({ name, description, input, options: { codemode: false }, execute: async (args, context) => {
              const call = { callId: context.id, name, arguments: args }
              await ctx.storage.put('lastTool', call)
              if (env.L4_TOOLS) {
                const response = await env.L4_TOOLS.fetch(new Request('http://l4/tools', {
                  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.job.capability}`, 'x-run-id': this.job.runId }, body: JSON.stringify(call), signal: context.signal,
                }))
                if (!response.ok) throw new Error(`L4 tool gateway rejected this call (${response.status})`)
                return { content: await response.text() }
              }
              // A synthetic tool for the cloud probe. Actual L4 authorization is tested locally via L4_TOOLS.
              if (name !== 'list_tasks') throw new Error('Writes are disabled in the cloud acceptance fixture')
              await ctx.storage.put('toolResult', { callId: context.id, name })
              return { content: JSON.stringify({ boards: [{ id: 'board-allowed', name: 'Allowed board' }], evidence: 'L4_TOOL_OK' }) }
            } })
          })
          await plugin.session.hook('retry', value => { value.decision = { retry: false } })
          await plugin.session.hook('http.request', async value => {
            this.modelCalls++
            await ctx.storage.put('modelCalls', this.modelCalls)
            if (this.modelCalls > (this.job?.maxModelCalls ?? 5)) throw new Error('L4 probe model budget exhausted')
            if (this.job?.fixture && env.MODEL) value.request = new Request('http://model/v1/chat/completions', value.request)
          })
        } }],
      })
    })
  }

  follow(host) {
    if (this.following) return
    this.following = true
    this.ctx.waitUntil((async () => {
      for await (const event of host.events.subscribe()) {
        const data = event.data
        if (!data || data.sessionID !== this.job?.sessionId) continue
        if (event.type === 'permission.asked') await host.permission.reply({ sessionID: data.sessionID, requestID: data.id, decision: 'reject', message: 'Native tools are disabled by the L4 acceptance fixture.' })
        if (event.type === 'session.text.ended') await this.ctx.storage.put('text', data.text)
        if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) {
          await this.ctx.storage.put('result', { type: event.type, ...(data.error ? { error: { type: data.error.type, status: data.error.status } } : {}) })
          break
        }
      }
    })().catch(error => console.log('probe.events.failed', error.name)))
  }

  async fetch(request) {
    try {
      const host = await this.host
      const path = new URL(request.url).pathname
      if (this.job) this.follow(host)
      if (path === '/evict') this.ctx.abort('L4 acceptance eviction')
      if (path === '/info') return Response.json(await host.server.info())
      if (path === '/start' && request.method === 'POST') {
        if (this.job) return new Response('Already started', { status: 409 })
        const input = await request.json()
        const session = await host.session.create({ title: 'L4 acceptance', location: { directory: '/workspace' }, model: { providerID: 'opencode', id: ['big-pickle','deepseek-v4.1-flash-free'].includes(input.model) ? input.model : 'glm-5.3-flash-free' }, permissions: [
          { action: '*', resource: '*', effect: 'ask' }, { action: 'list_tasks', resource: '*', effect: 'allow' }, { action: 'create_task', resource: '*', effect: 'allow' },
        ] })
        this.job = { sessionId: session.id, fixture: Boolean(input.fixture && this.env.MODEL), runId: input.runId, capability: input.capability, maxModelCalls: Math.min(8, input.maxModelCalls ?? 5) }
        await this.ctx.storage.put('job', this.job)
        this.follow(host)
        await host.session.prompt({ sessionID: session.id, text: input.prompt ?? 'Reply exactly OK. Do not use tools.' })
        return Response.json({ sessionId: session.id })
      }
      if (path === '/state') {
        const state = Object.fromEntries(await this.ctx.storage.list())
        delete state.job
        if (this.job) {
          state.sessionId = this.job.sessionId
          state.context = await host.session.context({ sessionID: this.job.sessionId })
          state.active = await host.session.active()
        }
        return Response.json(state)
      }
      if (path === '/cancel' && this.job) return Response.json(await host.session.interrupt({ sessionID: this.job.sessionId }))
      return new Response('Unknown operation', { status: 404 })
    } catch (error) { console.log('probe.failed', error.name, String(error).slice(0, 120)); return Response.json({ error: error.name }, { status: 500 }) }
  }
}

export default { async fetch(request, env) {
  if (!env.PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PROBE_TOKEN}` || Date.now() > Number(env.PROBE_EXPIRES)) return new Response('Not found', { status: 404 })
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/([a-z0-9-]{8,80})(\/.*)$/u)
  if (!match) return new Response('Not found', { status: 404 })
  url.pathname = match[2]
  return env.PROBE.getByName(match[1]).fetch(new Request(url, request))
} }
