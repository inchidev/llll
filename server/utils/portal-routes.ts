import type { H3Event } from 'h3'
import { PORTAL_ID, portalLive } from '../../shared/portal'
import { inlineScriptHashes, withScriptSources } from '../../shared/security-headers'
import { cf, fail } from './cf'
import { PORTAL_GUEST_HTML } from './portal-guest-page'
import { portalRoom } from './portals'
import { serverContentSecurityPolicy } from './security-policy'

function portalId(event: H3Event): string {
  const id = getRouterParam(event, 'id') ?? ''
  if (!PORTAL_ID.test(id)) fail(404, 'not_found', 'Portal not found')
  return id
}

/** Hand a host's or a guest's WebSocket to the Portal's Durable Object, which checks the key in its first frame. */
export function portalSocket(event: H3Event) {
  const { env, request } = cf(event)
  const id = portalId(event)
  if (!request || getHeader(event, 'upgrade') !== 'websocket') fail(426, 'upgrade_required', 'Expected WebSocket')
  if (!env.PORTAL_DO) fail(501, 'portal_unavailable', 'This Server was installed before Portal. Update it to use Portal.')
  return env.PORTAL_DO.getByName(`portal:${id}`).fetch(request)
}

const ENDED_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portal</title>'
  + '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#1e1f22;color:#dbdee1;font:16px system-ui,sans-serif">'
  + '<p>This Portal has ended. Ask the host for a new link.</p></body>'

/** PartyPortal's guest page, served by the Server; a Portal that has ended answers a short page instead. */
export async function portalPage(event: H3Event) {
  const id = portalId(event)
  const record = await portalRoom(cf(event).env, id).record()
  const html = portalLive(record) ? PORTAL_GUEST_HTML : ENDED_PAGE
  if (html === ENDED_PAGE) setResponseStatus(event, 404)
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex')
  setHeader(event, 'Content-Security-Policy', withScriptSources(serverContentSecurityPolicy("'none'"), await inlineScriptHashes(html)))
  return html
}
