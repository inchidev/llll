import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { resolve } from 'node:path'
const root = process.env.L4_PROBE_DIR
const upstream = process.env.L4_PROBE_UPSTREAM
const forward = async (request, url = request.url) => fetch(url, { method: request.method, headers: Object.fromEntries(request.headers), body: ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: 'manual' })
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, name: 'l4-opencode-acceptance', modules: true, scriptPath: resolve(import.meta.dirname, '../../../.deployment/opencode-acceptance/index.mjs'), compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROBE: { className: 'OpenCodeProbe', useSQLite: true, unsafeUniqueKey: 'l4-opencode-acceptance-v1' } }, resourcePersistencePath: root + '/durable',
  bindings: { PROBE_TOKEN: 'local-acceptance-only', PROBE_EXPIRES: String(Date.now() + 3600000) },
  serviceBindings: {
    L4_TOOLS: request => forward(request, upstream + '/tools'),
    MODEL: () => new Response('fixture'),
  }, outboundService: request => new URL(request.url).hostname === 'model' ? forward(request, upstream + '/model') : forward(request),
}))
const url = await mf.ready
process.send?.({ url: String(url) })
process.on('message', async message => {
  if (message === 'stop') { await mf.dispose(); process.exit(0) }
})
