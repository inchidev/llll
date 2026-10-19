export default {
  fetch(request: Request, env: { SHELL_ORIGIN?: string }): Response {
    const url = new URL(request.url)
    const path = /^\/[a-f0-9-]{36}(?:\/|$)/.test(url.pathname) ? url.pathname : '/open'
    const target = new URL(path, env.SHELL_ORIGIN || 'https://llll.gg')
    if (url.searchParams.has('server')) target.searchParams.set('server', url.searchParams.get('server')!)
    return Response.redirect(target.toString(), 302)
  },
} satisfies ExportedHandler<{ SHELL_ORIGIN?: string }>
