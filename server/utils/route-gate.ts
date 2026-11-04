import type { H3Event } from 'h3'
import { ACTION_RATE_LIMITS, SPACE_HEADER } from '../../shared/spaces'
import { currentUser } from './auth'
import { cf, fail } from './cf'
import { requireRateLimit } from './rate-limit'
import { recordingKeyOf } from './recording-keys'
import { matchRoutePolicy, type RoutePolicy } from './route-policy'
import { spaceOfResource, type SpaceRequest, type SpaceResourceKind } from './space-access'

type GateContext = { routePolicy?: RoutePolicy; spaceScope?: string | null }
const context = (event: H3Event) => (event.context ?? {}) as GateContext

/** What each handler answers for a missing resource, so a foreign one is indistinguishable. */
const MISSING: Partial<Record<SpaceResourceKind, string>> = {
  channel: 'Channel not found', message: 'Message not found', board: 'Board not found', task: 'Task not found', project: 'Project not found',
  database: 'Database not found', item: 'Item not found', document: 'Document not found', canvas: 'Canvas not found', gadget: 'App not found',
  attachment: 'File not found', taskAttachment: 'File not found', agent: 'Agent not found', schedule: 'Schedule not found', run: 'Run not found',
}

/** The Space this request works in, for loading a Member's authority. */
export function requestSpace(event: H3Event): SpaceRequest {
  const { routePolicy, spaceScope } = context(event)
  const scoped = routePolicy?.scope === 'space' || routePolicy?.scope === 'active'
  // Runs, Schedules and tokens save the authority they start with and recheck it against the Role later.
  return { spaceScope: scoped ? spaceScope ?? null : null, spaceAdmin: scoped && !/^(?:run|schedule|mcp-tokens)\./u.test(routePolicy.action) }
}

/**
 * The one HTTP check in front of every API route, before any permission. A resource in a Space
 * the caller is outside of answers as if it did not exist, and every limited action is counted
 * here. Handlers keep their own permission checks; Agents and MCP reach the same boundary through
 * their AuthorizationContext.
 */
export async function enforceRoutePolicy(event: H3Event): Promise<void> {
  const path = (event.path || '').split('?')[0]!
  if (!path.startsWith('/api/')) return
  const matched = matchRoutePolicy(event.method.toUpperCase(), path)
  // Every route file has a policy (a test holds this), so no match means no such route: the
  // catch-all answers 404. A mutation must never reach a handler without one.
  if (!matched) return
  const { policy, params } = matched
  context(event).routePolicy = policy
  if (policy.scope === 'unscoped' || policy.scope === 'account' || policy.scope === 'server') return
  const user = await currentUser(event)
  // Without an active Member the handler answers 401 or 403 as it always has.
  if (!user || user.status !== 'active') return
  const { env } = cf(event)
  const memberships = (await env.DB.prepare(`SELECT m.space_id AS spaceId, s.suspended_at IS NOT NULL AND m.user_id <> (SELECT owner_id FROM server) AS closed
    FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = ?`).bind(user.id).all<{ spaceId: string; closed: number }>()).results ?? []
  const mine = new Set(memberships.map(row => row.spaceId))
  // Said plainly, once the caller is known to belong: the Space has not gone anywhere.
  const refuseSuspended = (id: string | null) => {
    if (id && memberships.some(row => row.spaceId === id && row.closed)) fail(403, 'space_suspended', 'This Space is suspended. Nothing in it is lost. Contact the Server Owner.')
  }
  let spaceId: string | null
  if (policy.scope === 'space') {
    spaceId = await spaceOfResource(env, policy.resource, params[policy.param]!)
    // A Task number means something only inside a Space, so it takes the request's own.
    if (!spaceId && policy.resource === 'task' && /^[1-9]\d*$/u.test(params[policy.param]!)) {
      const requested = getHeader(event, SPACE_HEADER)?.trim()
      spaceId = requested && mine.has(requested) ? requested : mine.size === 1 ? [...mine][0]! : null
    }
    if (!spaceId) return
    if (!mine.has(spaceId)) fail(404, 'not_found', MISSING[policy.resource] ?? 'Not found')
  }
  else if (policy.scope === 'member') {
    const shared = await env.DB.prepare(`SELECT 1 AS ok FROM space_members a JOIN space_members b ON a.space_id = b.space_id
      WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`).bind(user.id, params[policy.param]!).first()
    if (!shared) fail(404, 'not_found', 'Not found')
    return
  }
  else {
    // A device key always works in the Space it was made in, and stops working on leaving it.
    const key = recordingKeyOf(event)
    if (key && !mine.has(key.spaceId)) fail(401, 'unauthorized', 'This key no longer works')
    const requested = key?.spaceId ?? getHeader(event, SPACE_HEADER)?.trim()
    spaceId = requested && mine.has(requested) ? requested : null
  }
  refuseSuspended(spaceId ?? (mine.size === 1 ? [...mine][0]! : null))
  context(event).spaceScope = spaceId
  await enforceActionLimit(event, policy.action, user.id, spaceId ?? (mine.size === 1 ? [...mine][0]! : null))
}

/** Hard per-Member limit on one action in one Space. A Space can tighten or loosen its defaults. */
export async function enforceActionLimit(event: H3Event, action: string, userId: string, spaceId: string | null) {
  const fallback = ACTION_RATE_LIMITS[action]
  if (!spaceId) {
    if (fallback) await requireRateLimit(event, [{ key: `action:${action}:${userId}`, limit: fallback.limit, windowMs: fallback.windowSeconds * 1000 }], 'Too many requests. Try again in a moment.')
    return
  }
  const { env } = cf(event)
  const saved = fallback || action.endsWith('.create') || action.endsWith('.update') || action.endsWith('.delete')
    ? await env.DB.prepare('SELECT action_limits_json AS json FROM spaces WHERE id = ?').bind(spaceId).first<{ json: string }>()
    : null
  let override: { limit: number; windowSeconds: number } | undefined
  try { override = saved ? (JSON.parse(saved.json) as Record<string, { limit: number; windowSeconds: number }>)[action] : undefined }
  catch { /* A broken override leaves the default in force. */ }
  const rule = override ?? fallback
  if (!rule) return
  await requireRateLimit(event, [{ key: `action:${spaceId}:${action}:${userId}`, limit: rule.limit, windowMs: rule.windowSeconds * 1000 }], 'Too many requests. Try again in a moment.')
}
