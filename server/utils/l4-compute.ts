import { z } from 'zod'
import type { AuthorizationContext } from '../../shared/authorization'
import { decryptSecret, encryptSecret } from '../../shared/encrypted-secret'
import { newId, nowIso } from '../../shared/ids'
import { DEFAULT_L4_COMPUTE_SIZE, L4_COMPUTE_ACCOUNT_URL, L4_COMPUTE_NODE_NAME, L4_COMPUTE_PRICING_URL, l4ComputeStatusSchema, projectCompute, type L4ComputeOverview, type L4ComputeSize, type L4ComputeStatus } from '../../shared/l4-compute'
import { getServerId } from '../../shared/server-id'
import { readServerSetting, sha256Hex, writeServerSetting } from '../../shared/server-settings'
import { isCloudHosted } from '../../shared/server-runtime'
import { L4_COMPUTE_CAPABILITIES } from '../../shared/software-factory'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireComputeOwner } from './compute-nodes'
import { factoryHash } from './factory-authority'
import { sameCapability } from './factory-boxes'
import { deleteBoxCheckpoints } from './box-checkpoints'
import { writeAudit } from './messages'

/**
 * L4 Compute (ADR 0009): llll.gg starts a microVM box for a Task of this Server, pairs it as a Compute Node
 * and bills the account by the hour of agent work. This Server links once, by the Owner's explicit step
 * through the browser, and holds a long-lived Server token for it; a Server hosted on L4 Cloud is linked by
 * construction and speaks with its `CLOUD_SECRET`. The Server never sees a price, and local work never waits
 * for llll.gg: a failure to reach it shows as such.
 */
const TOKEN_SCOPE = 'l4-compute-token'
const LINK_STATE_SETTING = 'l4_compute_link_state'
const STATUS_SETTING = 'l4_compute_status'
/** How long the credit status llll.gg last gave is shown before asking again. */
export const L4_STATUS_CACHE_MS = 60000
const LINK_STATE_MS = 10 * 60000
const BOX_PAIRING_MS = 15 * 60000
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** Where llll.gg is. Only local development of the two sides together moves it. */
export const l4ComputeSite = (env: Pick<L4Env, 'LLLL_CLOUD_SITE'>) => env.LLLL_CLOUD_SITE?.trim().replace(/\/+$/u, '') || 'https://llll.gg'
export const L4_COMPUTE_UNREACHABLE = 'llll.gg unreachable'

export type L4Credential = { kind: 'hosted' | 'linked'; authorization: string; account: string | null; linkedAt: string | null }
/**
 * How this Server speaks to llll.gg about compute, or null when it is not linked: the Server token as llll.gg
 * gave it (`l4c.<uuid>.<secret>`), or on L4 Cloud the relay secret as `l4h.<Server UUID>.<CLOUD_SECRET>`.
 */
export async function l4ComputeCredential(env: L4Env): Promise<L4Credential | null> {
  if (isCloudHosted(env)) {
    const cloudSecret = env.CLOUD_SECRET?.trim()
    return cloudSecret && cloudSecret.length >= 16 ? { kind: 'hosted', authorization: `Bearer l4h.${await getServerId(env.DB)}.${cloudSecret}`, account: null, linkedAt: null } : null
  }
  const row = await env.DB.prepare('SELECT account,token_ciphertext AS ciphertext,token_iv AS iv,token_version AS version,linked_at AS linkedAt FROM l4_compute_link WHERE singleton=1')
    .first<{ account: string; ciphertext: string; iv: string; version: number; linkedAt: string }>()
  if (!row || !env.AUTH_SECRET) return null
  const token = await decryptSecret(env.AUTH_SECRET, TOKEN_SCOPE, { ciphertext: row.ciphertext, iv: row.iv, version: row.version })
  return { kind: 'linked', authorization: `Bearer ${token}`, account: row.account, linkedAt: row.linkedAt }
}

/** One request to llll.gg. Redirects are not followed (Workers allow only manual here); a 3xx is a response that is not ok and counts as a failure. */
async function l4Fetch(env: L4Env, credential: L4Credential, path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 10000) {
  return fetch(`${l4ComputeSite(env)}${path}`, { method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: credential.authorization, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body) })
}

function serverOrigin(env: L4Env) {
  try { return new URL(env.PUBLIC_ORIGIN || '').origin } catch { return null }
}

/** The Server's placement Node for L4 Compute; made on the first need once linked, enabled again on a new link. */
export async function ensureL4PlacementNode(env: L4Env, createdBy?: string | null): Promise<string | null> {
  const existing = await env.DB.prepare("SELECT id,enabled FROM compute_nodes WHERE placement_id IS NULL AND json_extract(capabilities_json,'$.provider')='l4-compute' ORDER BY created_at LIMIT 1").first<{ id: string; enabled: number }>()
  if (existing) {
    if (!existing.enabled) await env.DB.prepare('UPDATE compute_nodes SET enabled=1,last_seen=? WHERE id=?').bind(nowIso(), existing.id).run()
    return existing.id
  }
  const owner = createdBy ?? (await env.DB.prepare('SELECT owner_id AS id FROM server WHERE owner_id IS NOT NULL').first<{ id: string }>())?.id
  if (!owner) return null
  const id = newId()
  await env.DB.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, L4_COMPUTE_NODE_NAME, await factoryHash(secret()), JSON.stringify(L4_COMPUTE_CAPABILITIES), nowIso(), owner, nowIso()).run()
  return id
}
export async function l4PlacementNodeId(env: L4Env) {
  return (await env.DB.prepare("SELECT id FROM compute_nodes WHERE placement_id IS NULL AND json_extract(capabilities_json,'$.provider')='l4-compute' ORDER BY created_at LIMIT 1").first<{ id: string }>())?.id ?? null
}

/**
 * Starts the Owner's link: a nonce this Server remembers hashed, and the llll.gg address the browser goes to.
 * llll.gg brings the browser back to `/api/compute/cloud/callback` with a code and the same nonce.
 */
export async function beginL4ComputeLink(env: L4Env, auth: AuthorizationContext) {
  requireComputeOwner(auth)
  if (isCloudHosted(env)) fail(409, 'compute_hosted', 'A Server on L4 Cloud is linked to L4 Compute by itself')
  const origin = serverOrigin(env)
  if (!origin) fail(409, 'compute_origin', 'Configure this Server’s public origin before linking L4 Compute')
  if (await env.DB.prepare('SELECT 1 FROM l4_compute_link WHERE singleton=1').first()) fail(409, 'compute_linked', 'This Server is already linked to L4 Compute. Disconnect it first.')
  const nonce = secret()
  await writeServerSetting(env.DB, LINK_STATE_SETTING, JSON.stringify({ hash: await sha256Hex(nonce), by: auth.principal.id, expiresAt: new Date(Date.now() + LINK_STATE_MS).toISOString() }))
  const url = new URL('/compute/connect', l4ComputeSite(env))
  url.searchParams.set('server', origin)
  url.searchParams.set('id', await getServerId(env.DB))
  url.searchParams.set('state', nonce)
  return { url: url.toString() }
}

const linkResponse = z.object({ token: z.string().min(16).max(4096),
  account: z.union([z.string().max(200), z.object({ email: z.string().max(200).optional(), name: z.string().max(200).optional() }).passthrough()]).optional() })
/** The nonce came back with a code: exchange it server to server for the Server token and keep that encrypted. */
export async function completeL4ComputeLink(env: L4Env, auth: AuthorizationContext, code: string, state: string) {
  requireComputeOwner(auth)
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'compute_link_failed', 'Server credential encryption is unavailable')
  const origin = serverOrigin(env)
  if (!origin) fail(409, 'compute_origin', 'Configure this Server’s public origin before linking L4 Compute')
  const pending = JSON.parse(await readServerSetting(env.DB, LINK_STATE_SETTING) ?? 'null') as { hash: string; by: string; expiresAt: string } | null
  // One answer per start, whatever it says.
  await env.DB.prepare('DELETE FROM server_settings WHERE key=?').bind(LINK_STATE_SETTING).run()
  if (!pending || pending.by !== auth.principal.id || pending.expiresAt <= nowIso() || !sameCapability(await sha256Hex(state), pending.hash)) fail(403, 'compute_link_state', 'This link request is not the one this Server started. Start again from Settings → Compute.')
  let response: Response
  try {
    response = await fetch(`${l4ComputeSite(env)}/api/compute/link`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ code, serverId: await getServerId(env.DB), serverOrigin: origin }) })
  } catch { fail(502, 'compute_link_failed', `${L4_COMPUTE_UNREACHABLE}; the link was not completed. Try again.`) }
  if (!response.ok) fail(502, 'compute_link_failed', `llll.gg did not accept the link (${response.status}). Start again from Settings → Compute.`)
  const parsed = linkResponse.safeParse(await response.json().catch(() => null))
  if (!parsed.success) fail(502, 'compute_link_failed', 'llll.gg answered the link in an unexpected form')
  const account = typeof parsed.data.account === 'string' ? parsed.data.account : parsed.data.account?.email || parsed.data.account?.name || 'llll.gg account'
  const encrypted = await encryptSecret(env.AUTH_SECRET, TOKEN_SCOPE, parsed.data.token)
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO l4_compute_link(singleton,account,token_ciphertext,token_iv,token_version,linked_by,linked_at) VALUES(1,?,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET account=excluded.account,token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,token_version=excluded.token_version,linked_by=excluded.linked_by,linked_at=excluded.linked_at`)
      .bind(account, encrypted.ciphertext, encrypted.iv, encrypted.version, auth.principal.id, nowIso()),
    env.DB.prepare('DELETE FROM server_settings WHERE key=?').bind(STATUS_SETTING),
  ])
  await ensureL4PlacementNode(env, auth.principal.id)
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'compute.l4.link', targetType: 'server', targetId: auth.serverId, authorization: auth, meta: { account } })
  return { account }
}

/** Ends the link: every box of this Server on L4 Compute is released, the token forgotten, the placement paused. */
export async function disconnectL4Compute(env: L4Env, auth: AuthorizationContext) {
  requireComputeOwner(auth)
  if (isCloudHosted(env)) fail(409, 'compute_hosted', 'A Server on L4 Cloud cannot disconnect from L4 Compute')
  const boxes = await env.DB.prepare(`SELECT b.id FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id WHERE b.status<>'released'
    AND (n.placement_id IS NOT NULL OR json_extract(n.capabilities_json,'$.provider')='l4-compute')`).all<{ id: string }>()
  await releaseL4Boxes(env, boxes.results.map(box => box.id))
  const placement = await l4PlacementNodeId(env)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM l4_compute_link WHERE singleton=1'),
    env.DB.prepare('DELETE FROM server_settings WHERE key IN (?,?)').bind(STATUS_SETTING, LINK_STATE_SETTING),
    ...(placement ? [env.DB.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=? OR placement_id=?').bind(placement, placement)] : []),
  ])
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'compute.l4.disconnect', targetType: 'server', targetId: auth.serverId, authorization: auth, meta: { released: boxes.results.length } })
}

type CachedStatus = { at: string; status: L4ComputeStatus | null; error: string | null }
/** The credit, this month's spend and the limit as llll.gg reports them, kept a minute; a failure keeps the last answer and says so. */
export async function l4ComputeStatus(env: L4Env, credential: L4Credential, force = false): Promise<CachedStatus> {
  const cached = JSON.parse(await readServerSetting(env.DB, STATUS_SETTING) ?? 'null') as CachedStatus | null
  if (cached && !force && Date.parse(cached.at) + L4_STATUS_CACHE_MS > Date.now()) return cached
  let next: CachedStatus
  try {
    const response = await l4Fetch(env, credential, '/api/compute/status', {}, 5000)
    if (!response.ok) throw new Error(String(response.status))
    const parsed = l4ComputeStatusSchema.safeParse(await response.json())
    next = parsed.success ? { at: nowIso(), status: parsed.data, error: null } : { at: nowIso(), status: cached?.status ?? null, error: 'llll.gg answered in an unexpected form' }
  } catch { next = { at: nowIso(), status: cached?.status ?? null, error: L4_COMPUTE_UNREACHABLE } }
  await writeServerSetting(env.DB, STATUS_SETTING, JSON.stringify(next))
  return next
}

/** L4 Compute as Settings → Compute shows it. Reading it makes a hosted Server's placement Node if it has none yet. */
export async function l4ComputeOverview(env: L4Env): Promise<L4ComputeOverview> {
  const hosted = isCloudHosted(env)
  const credential = await l4ComputeCredential(env)
  const nodeId = credential ? await ensureL4PlacementNode(env) : await l4PlacementNodeId(env)
  const status = credential ? await l4ComputeStatus(env, credential) : null
  const boxes = nodeId ? await env.DB.prepare(`SELECT (SELECT count(*) FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id WHERE (n.id=? OR n.placement_id=?) AND b.status<>'released') AS retained,
    (SELECT count(*) FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id WHERE (n.id=? OR n.placement_id=?) AND b.status IN ('starting','running','idle')) AS active`).bind(nodeId, nodeId, nodeId, nodeId).first<{ retained: number; active: number }>() : null
  return { linked: Boolean(credential), hosted, account: credential?.account ?? null, linkedAt: credential?.linkedAt ?? null,
    canConnect: !hosted && !credential && Boolean(serverOrigin(env)), nodeId,
    status: status?.status ?? null, statusError: status?.error ?? null, statusAt: status?.at ?? null,
    boxes: { active: boxes?.active ?? 0, retained: boxes?.retained ?? 0 }, pricingUrl: L4_COMPUTE_PRICING_URL, accountUrl: L4_COMPUTE_ACCOUNT_URL }
}

/** Marks what the Task shows about its box on L4 Compute; null clears it once a box is there. */
async function noteTask(env: L4Env, taskId: string, state: 'l4_credit' | 'l4_unreachable' | null, message: string | null) {
  await env.DB.prepare(`UPDATE tasks SET factory_state=CASE WHEN ? IS NULL THEN CASE WHEN factory_state IN ('l4_credit','l4_unreachable') THEN NULL ELSE factory_state END ELSE ? END,
    last_error=CASE WHEN ? IS NULL THEN CASE WHEN factory_state IN ('l4_credit','l4_unreachable') THEN NULL ELSE last_error END ELSE ? END WHERE id=?`).bind(state, state, message, message, taskId).run()
}
export const L4_CREDIT_MESSAGE = `L4 Compute has no credit, or this month’s spend limit is reached. Buy credit at ${L4_COMPUTE_ACCOUNT_URL}, then start the Task again.`

const boxResponse = z.object({ boxId: z.string().min(1).max(200) }).passthrough()
/**
 * A Task's first turn on the L4 Compute placement: mint a one-use pairing code bound to this box, then ask
 * llll.gg for a box of the Project's size. The box pairs itself as a Node under the placement and is then an
 * ordinary Node with a durable disk. A 402 is shown on the Task with where to buy credit; nothing retries it.
 */
export async function requestL4Box(env: L4Env, box: { id: string; taskId: string; initiatedBy: string }) {
  const credential = await l4ComputeCredential(env)
  if (!credential) fail(403, 'compute_unlinked', 'L4 Compute is not linked to this Server. Add it in Server settings → Compute.')
  const origin = serverOrigin(env)
  if (!origin) fail(403, 'compute_origin', 'Configure this Server’s public origin before using L4 Compute')
  const project = await env.DB.prepare('SELECT p.factory_json AS factoryJson FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').bind(box.taskId).first<{ factoryJson: string | null }>()
  const size: L4ComputeSize = project ? projectCompute(project.factoryJson).size : DEFAULT_L4_COMPUTE_SIZE
  const pairingToken = secret()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM compute_pairings WHERE box_id=? OR expires_at<=?').bind(box.id, nowIso()),
    env.DB.prepare('INSERT INTO compute_pairings(token_hash,name,created_by,expires_at,box_id) VALUES(?,?,?,?,?)')
      .bind(await factoryHash(pairingToken), L4_COMPUTE_NODE_NAME, box.initiatedBy, new Date(Date.now() + BOX_PAIRING_MS).toISOString(), box.id),
  ])
  const dropPairing = () => env.DB.prepare('DELETE FROM compute_pairings WHERE box_id=?').bind(box.id).run()
  let response: Response
  try { response = await l4Fetch(env, credential, '/api/compute/boxes', { method: 'POST', body: { taskId: box.taskId, size, pairingToken, serverOrigin: origin } }, 20000) }
  catch {
    await dropPairing()
    await noteTask(env, box.taskId, 'l4_unreachable', `${L4_COMPUTE_UNREACHABLE}; the Task asks for its box again on its next turn.`)
    fail(503, 'compute_unreachable', `${L4_COMPUTE_UNREACHABLE}; the Task asks for its box again on its next turn.`)
  }
  if (response.status === 402) {
    await dropPairing()
    await noteTask(env, box.taskId, 'l4_credit', L4_CREDIT_MESSAGE)
    fail(403, 'compute_credit', L4_CREDIT_MESSAGE)
  }
  if (!response.ok) {
    await dropPairing()
    fail(502, 'compute_box', `llll.gg did not start a box (${response.status}). The Task asks again on its next turn.`)
  }
  const parsed = boxResponse.safeParse(await response.json().catch(() => null))
  if (!parsed.success) { await dropPairing(); fail(502, 'compute_box', 'llll.gg answered the box request in an unexpected form') }
  await env.DB.prepare('UPDATE factory_boxes SET cloud_box_id=?,cloud_size=?,updated_at=? WHERE id=?').bind(parsed.data.boxId, size, nowIso(), box.id).run()
  await noteTask(env, box.taskId, null, null)
  return { cloudBoxId: parsed.data.boxId, size }
}

/**
 * The box's daemon paired: tell llll.gg, which otherwise destroys a box unconfirmed ten minutes after it was made.
 * A confirmation that does not get through is tried again on the box's Node's next sync, until it does.
 */
export async function confirmL4Boxes(env: L4Env, boxIds: string[]) {
  if (!boxIds.length) return []
  const rows = await env.DB.prepare(`SELECT id,cloud_box_id AS cloudBoxId FROM factory_boxes WHERE id IN (SELECT value FROM json_each(?)) AND cloud_box_id IS NOT NULL AND cloud_confirmed_at IS NULL AND status<>'released'`)
    .bind(JSON.stringify(boxIds)).all<{ id: string; cloudBoxId: string }>()
  if (!rows.results.length) return []
  const credential = await l4ComputeCredential(env)
  if (!credential) return []
  const confirmed: string[] = []
  for (const row of rows.results) {
    const response = await l4Fetch(env, credential, `/api/compute/boxes/${encodeURIComponent(row.cloudBoxId)}/confirm`, { method: 'POST' }).catch(() => null)
    // 404: llll.gg no longer has the box (unconfirmed in time, or unlinked); the Node's next sync shows it gone.
    if (!response || !(response.ok || response.status === 404)) continue
    await env.DB.prepare('UPDATE factory_boxes SET cloud_confirmed_at=?,updated_at=? WHERE id=? AND cloud_confirmed_at IS NULL').bind(nowIso(), nowIso(), row.id).run()
    confirmed.push(row.id)
  }
  return confirmed
}
/** The boxes of one Node whose confirmation llll.gg has not had yet. */
export async function unconfirmedL4Boxes(env: L4Env, nodeId: string) {
  const rows = await env.DB.prepare("SELECT id FROM factory_boxes WHERE node_id=? AND cloud_box_id IS NOT NULL AND cloud_confirmed_at IS NULL AND status<>'released'").bind(nodeId).all<{ id: string }>()
  return rows.results.map(row => row.id)
}

/** How long a box's own Node on L4 Compute may stay silent before the box counts as lost. A Node syncs every few seconds. */
export const L4_BOX_LOST_MS = 3 * 60_000
/**
 * A box on L4 Compute whose own Node is gone (its sandbox ended or was removed, or the Node is disabled) cannot take
 * another turn: its disk went with its sandbox. Its llll.gg box is let go, its Node revoked, and the box goes back to
 * the placement as new (no lease), keeping what it published and its last acknowledged checkpoint, so the turn asks
 * llll.gg for a box again and starts from that checkpoint, or from the pinned source when it has none. Work after the
 * checkpoint went with the sandbox. A box not yet paired, or whose Node is alive, is left alone. Returns whether it reset.
 */
export async function resetLostL4Box(env: L4Env, boxId: string, placementNodeId: string, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT b.cloud_box_id AS cloudBoxId,n.id AS nodeId,n.enabled,n.last_seen AS lastSeen,n.placement_id AS placementId
    FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id WHERE b.id=?`).bind(boxId).first<{ cloudBoxId: string | null; nodeId: string; enabled: number; lastSeen: string | null; placementId: string | null }>()
  if (!row?.cloudBoxId || row.placementId !== placementNodeId) return false
  if (row.enabled && row.lastSeen && Date.parse(row.lastSeen) >= now - L4_BOX_LOST_MS) return false
  const credential = await l4ComputeCredential(env)
  if (credential) await l4Fetch(env, credential, `/api/compute/boxes/${encodeURIComponent(row.cloudBoxId)}`, { method: 'DELETE' }).catch(() => undefined)
  await env.DB.batch([
    env.DB.prepare(`UPDATE factory_boxes SET node_id=?,status='new',cloud_box_id=NULL,cloud_size=NULL,cloud_confirmed_at=NULL,lease_token=NULL,lease_until=NULL,cpu=NULL,memory_mib=NULL,preview=0,
      updated_at=? WHERE id=?`).bind(placementNodeId, nowIso(), boxId),
    env.DB.prepare('UPDATE compute_nodes SET enabled=0,token_hash=? WHERE id=?').bind(await factoryHash(secret()), row.nodeId),
    env.DB.prepare('DELETE FROM compute_pairings WHERE box_id=?').bind(boxId),
  ])
  console.warn('l4-compute.box_lost', { boxId })
  return true
}

/**
 * An idle box on L4 Compute gives its machine back: llll.gg bills a box for as long as it lives, and an idle one only
 * keeps its disk. Its daemon saved the disk to the box's checkpoint and says, as it reports the box stopped, which
 * checkpoint that is. Only when that is the box's acknowledged checkpoint and no turn waits for it does the box go
 * back to the placement as new, keeping its checkpoint, and its llll.gg box and Node go; the next turn asks llll.gg
 * for a box, which restores the checkpoint. The box moves first, in one statement that a new turn's claim on it
 * would fail, so a turn never waits on a machine that is going. Returns whether it parked.
 */
export async function parkL4Box(env: L4Env, boxId: string, nodeId: string, placementNodeId: string, saved: string) {
  const row = await env.DB.prepare(`SELECT cloud_box_id AS cloudBoxId FROM factory_boxes WHERE id=? AND node_id=? AND status='stopped' AND checkpoint_sha=? AND cloud_box_id IS NOT NULL`)
    .bind(boxId, nodeId, saved).first<{ cloudBoxId: string }>()
  if (!row) return false
  const moved = await env.DB.prepare(`UPDATE factory_boxes SET node_id=?,status='new',cloud_box_id=NULL,cloud_size=NULL,cloud_confirmed_at=NULL,lease_token=NULL,lease_until=NULL,cpu=NULL,memory_mib=NULL,preview=0,run_id=NULL,updated_at=?
    WHERE id=? AND node_id=? AND status='stopped' AND checkpoint_sha=? AND cloud_box_id=? AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM agent_runs WHERE status='running')) RETURNING id`)
    .bind(placementNodeId, nowIso(), boxId, nodeId, saved, row.cloudBoxId).first()
  if (!moved) return false
  await env.DB.batch([
    env.DB.prepare('UPDATE compute_nodes SET enabled=0,token_hash=? WHERE id=?').bind(await factoryHash(secret()), nodeId),
    env.DB.prepare('DELETE FROM compute_pairings WHERE box_id=?').bind(boxId),
  ])
  // Like a release, one llll.gg cannot be told about now is left to its sweep.
  const credential = await l4ComputeCredential(env)
  if (credential) await l4Fetch(env, credential, `/api/compute/boxes/${encodeURIComponent(row.cloudBoxId)}`, { method: 'DELETE' }).catch(() => undefined)
  console.info('l4-compute.box_parked', { boxId })
  return true
}

/**
 * Releases boxes of this Server on L4 Compute: llll.gg stops and bills each one, the box is released here, its Node
 * revoked and its checkpoint repository deleted. Boxes on other Nodes are left alone, so the caller may pass any box ids.
 */
export async function releaseL4Boxes(env: L4Env, boxIds: string[]) {
  if (!boxIds.length) return []
  const rows = await env.DB.prepare(`SELECT b.id,b.cloud_box_id AS cloudBoxId FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id
    WHERE b.id IN (SELECT value FROM json_each(?)) AND (n.placement_id IS NOT NULL OR json_extract(n.capabilities_json,'$.provider')='l4-compute')`).bind(JSON.stringify(boxIds)).all<{ id: string; cloudBoxId: string | null }>()
  if (!rows.results.length) return []
  const credential = await l4ComputeCredential(env)
  for (const row of rows.results) {
    // A box llll.gg no longer knows is released all the same; one it cannot be told about now is stopped by its own idle rule.
    if (credential && row.cloudBoxId) await l4Fetch(env, credential, `/api/compute/boxes/${encodeURIComponent(row.cloudBoxId)}`, { method: 'DELETE' }).catch(() => undefined)
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_boxes SET status='released',lease_token=NULL,lease_until=NULL,cpu=NULL,memory_mib=NULL,run_id=NULL,preview=0,updated_at=? WHERE id=?").bind(nowIso(), row.id),
      env.DB.prepare('UPDATE compute_nodes SET enabled=0,token_hash=? WHERE box_id=?').bind(await factoryHash(secret()), row.id),
      env.DB.prepare('DELETE FROM compute_pairings WHERE box_id=?').bind(row.id),
    ])
  }
  await deleteBoxCheckpoints(env, rows.results.map(row => row.id))
  return rows.results.map(row => row.id)
}

/** A Task is Done or archived: its boxes on L4 Compute go once no turn runs on them. */
export async function releaseL4BoxesForTasks(env: L4Env, taskIds: string[]) {
  if (!taskIds.length) return []
  const rows = await env.DB.prepare(`SELECT b.id FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id JOIN tasks t ON t.id=b.task_id
    WHERE b.task_id IN (SELECT value FROM json_each(?)) AND b.status<>'released' AND (t.status='done' OR t.archived_at IS NOT NULL)
    AND (n.placement_id IS NOT NULL OR json_extract(n.capabilities_json,'$.provider')='l4-compute')
    AND (b.run_id IS NULL OR b.run_id NOT IN (SELECT id FROM agent_runs WHERE status='running'))`).bind(JSON.stringify(taskIds)).all<{ id: string }>()
  return releaseL4Boxes(env, rows.results.map(row => row.id))
}

const previewResponse = z.object({ url: z.string().url().max(4096) }).passthrough()
/**
 * Where a box's screen can be watched: llll.gg exposes the box's preview port over HTTPS (`POST
 * /api/compute/boxes/:id/preview`) and answers its address, which carries the provider's own access token. Null when
 * llll.gg has no preview for the box (gone, not running, or a template without one); a failure to reach it is a 502.
 */
export async function l4BoxPreviewUrl(env: L4Env, cloudBoxId: string) {
  const credential = await l4ComputeCredential(env)
  if (!credential) return null
  let response: Response
  try { response = await l4Fetch(env, credential, `/api/compute/boxes/${encodeURIComponent(cloudBoxId)}/preview`, { method: 'POST' }, 15000) }
  catch { fail(502, 'preview_unreachable', `${L4_COMPUTE_UNREACHABLE}; the box’s screen cannot be shown now.`) }
  if (response.status === 404 || response.status === 409) { await response.body?.cancel(); return null }
  if (!response.ok) { await response.body?.cancel(); fail(502, 'preview_unreachable', `llll.gg did not open the box’s screen (${response.status}).`) }
  const parsed = previewResponse.safeParse(await response.json().catch(() => null))
  if (!parsed.success || new URL(parsed.data.url).protocol !== 'https:') fail(502, 'preview_unreachable', 'llll.gg answered the preview in an unexpected form')
  return parsed.data.url
}
