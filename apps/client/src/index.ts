import { version } from '../../../package.json'
export default {
  fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> | Response {
    const url = new URL(request.url)
    if (url.pathname === '/.well-known/llll') return Response.json({ product: 'llll', kind: 'client', apiVersion: 1, version, origin: url.origin, name: 'L4', id: 'client', registration: false, telegram: false }, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } })
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return Response.json({ error: { message: 'Connect an installation to use L4' } }, { status: 404 })
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>
