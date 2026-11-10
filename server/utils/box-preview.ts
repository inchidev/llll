import type { AuthorizationContext } from '../../shared/authorization'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { leaseCapability } from './factory-boxes'
import { l4BoxPreviewUrl } from './l4-compute'
import { getTask } from './task-service'

/**
 * Watching a Task's box (ADR 0011, amended): its Node streams the box's screen with voxl behind a preview gate, and
 * a person who may read the Task gets a link that works for a short time. Nothing secret is stored for it: the
 * box's preview key is derived from its lease, so it changes with every start of the box and ends with it, and the
 * Server hands it only to the Node in its sync. A ticket is the box, an expiry and a signature under that key.
 * Viewing is no turn and keeps nothing running: the box stops when idle whoever watches.
 */
export const PREVIEW_TICKET_MS = 30 * 60_000

/** The key a box's preview gate checks tickets with, for the box's current lease. */
export const boxPreviewKey = (env: L4Env, boxId: string, lease: string) => leaseCapability(env, 'compute-preview', boxId, lease)

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
/** A ticket the gate accepts until `expiresAt`: `<box id>.<expires, ms>.<HMAC-SHA256(key, "<box id>.<expires>")>`. */
export async function previewTicket(key: string, boxId: string, expiresAt: number) {
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `${boxId}.${expiresAt}.${hex(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${boxId}.${expiresAt}`)))}`
}

/** A Task's box whose Node reports a viewer now, under a live lease, on L4 Compute (the only placement that exposes it). */
export async function previewableBox(env: L4Env, taskId: string) {
  return env.DB.prepare(`SELECT b.id,b.lease_token AS lease,b.cloud_box_id AS cloudBoxId FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id
    WHERE b.task_id=? AND b.status IN ('idle','running') AND b.preview=1 AND b.lease_token IS NOT NULL AND b.lease_until>? AND b.cloud_box_id IS NOT NULL
    AND n.enabled=1 AND n.placement_id IS NOT NULL ORDER BY b.updated_at DESC,b.id LIMIT 1`).bind(taskId, nowIso()).first<{ id: string; lease: string; cloudBoxId: string }>()
}

/**
 * A short-lived link to watch the Task's box, for a person who may read the Task, or null when there is nothing to
 * watch (no box running, or its Node has no viewer). The link is llll.gg's HTTPS address of the box's preview port
 * with a ticket as `token`, which voxl's page passes on to its stream.
 */
export async function taskPreview(env: L4Env, auth: AuthorizationContext, taskId: string, now = Date.now()) {
  let task: Awaited<ReturnType<typeof getTask>> = null
  try { task = await getTask(env, auth, taskId) }
  catch (error) { if (![403, 404].includes((error as { statusCode?: number })?.statusCode ?? 0)) throw error }
  if (!task || task.id !== taskId) fail(404, 'not_found', 'Task not found')
  const box = await previewableBox(env, taskId)
  if (!box) return null
  const address = await l4BoxPreviewUrl(env, box.cloudBoxId)
  if (!address) return null
  const expiresAt = now + PREVIEW_TICKET_MS
  const url = new URL(address)
  url.searchParams.set('token', await previewTicket(await boxPreviewKey(env, box.id, box.lease), box.id, expiresAt))
  return { url: url.toString(), expiresAt: new Date(expiresAt).toISOString() }
}
