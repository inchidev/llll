import type { RunMandate } from '../../shared/agent-execution'
import type { AgentExecutionMode } from '../../shared/agent-execution-policy'
import { decryptSecret } from '../../shared/encrypted-secret'
import { networkHosts, PLACEHOLDER_PATTERN, projectNetwork, type ProjectNetwork } from '../../shared/project-factory'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { factoryHash } from './factory-authority'
import { fail } from './cf'

/**
 * What one box may reach, and which Project secrets its egress layer puts in (ADR 0011).
 *
 * The hosts in effect are this Server, the Project's presets and hosts, and the Task windows a person (or the
 * mode) opened whose time has not run out. A secret is put in only on a host it is bound to, and only as the
 * mode allows: in role mode every bound secret; in plan mode the secrets the latest approved plan names; in
 * review mode none on its own. A window that names a secret, once open, allows it at its host in any mode.
 * Everywhere else the placeholder is left as it is, and a request carrying it is refused, so the Agent learns
 * to ask for a window instead of sending a placeholder to a service.
 *
 * The same compiled list is enforced by the daemon's proxy on a VPS Node and by BoxOutbound on Cloudflare.
 */
export type EgressSecret = { id: string; name: string; placeholder: string; hosts: string[]; updatedAt: string }
export type EgressWindow = { host: string; secrets: string[]; expiresAt: string }
export type EgressInput = { serverHosts: string[]; network: ProjectNetwork; secrets: EgressSecret[]; windows: EgressWindow[]
  /** The secrets and hosts the box's latest plan names, if a person approved it. */
  plan: { hosts: string[]; secrets: string[] } | null; mode: AgentExecutionMode; now: string }
/** A Project secret any box of the Project may carry as a placeholder, with the hosts it is bound to. */
export type KnownPlaceholder = { placeholder: string; name: string; hosts: string[] }
export type CompiledEgress = {
  /** Changes whenever anything below changes, including a replaced value, so a Node reloads only then. */
  revision: string
  hosts: string[]
  /** The hosts open without a window: this Server and the Project's network. */
  listed: string[]
  /** Open hosts some Project secret is bound to: the VPS proxy terminates TLS only for these. */
  secretHosts: string[]
  known: KnownPlaceholder[]
  /** The secrets in effect, each with the open hosts where it is put in. */
  secrets: Array<{ id: string; placeholder: string; hosts: string[] }>
  projectId: string | null
}

const unique = (values: Iterable<string>) => [...new Set(values)].sort()

/** The rules alone, without the database: what a box reaches and which secrets go where. */
export async function compileEgress(input: EgressInput & { projectId?: string | null }): Promise<CompiledEgress> {
  const open = input.windows.filter(window => window.expiresAt > input.now)
  const listed = unique([...input.serverHosts, ...networkHosts(input.network)])
  const hosts = unique([...listed, ...open.map(window => window.host)])
  const isOpen = new Set(hosts), bound = new Set(input.secrets.flatMap(secret => secret.hosts))
  const secrets = input.secrets.map(secret => {
    const windowed = open.filter(window => window.secrets.includes(secret.name)).map(window => window.host)
    const byMode = input.mode === 'role' || (input.mode === 'plan' && input.plan?.secrets.includes(secret.name)) ? secret.hosts : []
    const allowed = new Set([...byMode, ...windowed])
    return { id: secret.id, placeholder: secret.placeholder, hosts: unique(secret.hosts.filter(host => allowed.has(host) && isOpen.has(host))) }
  }).filter(secret => secret.hosts.length).sort((a, b) => a.placeholder.localeCompare(b.placeholder))
  const known = input.secrets.map(secret => ({ placeholder: secret.placeholder, name: secret.name, hosts: unique(secret.hosts) })).sort((a, b) => a.placeholder.localeCompare(b.placeholder))
  const secretHosts = hosts.filter(host => bound.has(host))
  const versions = input.secrets.map(secret => `${secret.id}:${secret.updatedAt}`).sort()
  const revision = (await factoryHash(JSON.stringify({ hosts, secretHosts, known, secrets, versions }))).slice(0, 32)
  return { revision, hosts, listed, secretHosts, known, secrets, projectId: input.projectId ?? null }
}

/** This Server's own host names: a box always reaches the Server's gateway. */
export function serverHosts(env: L4Env) {
  return [env.PUBLIC_ORIGIN, env.AGENT_CALLBACK_ORIGIN].flatMap(origin => { try { return origin ? [new URL(origin).hostname] : [] } catch { return [] } })
}

type BoxRow = { id: string; projectId: string | null; factoryJson: string | null; archivedAt: string | null; mandateJson: string | null }
/** The Project of each box: the one its repository is attached to. A box of an archived Project, or of none, reaches only the Server. */
async function projectsOf(env: L4Env, boxIds: string[]) {
  return (await env.DB.prepare(`SELECT b.id,p.id AS projectId,p.factory_json AS factoryJson,p.archived_at AS archivedAt,r.mandate_json AS mandateJson FROM factory_boxes b
    LEFT JOIN project_repositories pr ON pr.environment_id=json_extract(b.environment_json,'$.id')
    LEFT JOIN projects p ON p.id=pr.project_id
    LEFT JOIN agent_runs r ON r.id=b.run_id AND r.status='running'
    WHERE b.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(boxIds)).all<BoxRow>()).results
}
/** Every secret of these Projects, without its value. */
export async function projectEgressSecrets(env: L4Env, projectIds: string[]) {
  if (!projectIds.length) return new Map<string, EgressSecret[]>()
  const rows = (await env.DB.prepare(`SELECT id,project_id AS projectId,name,placeholder,hosts_json AS hostsJson,updated_at AS updatedAt FROM project_secrets
    WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY name`).bind(JSON.stringify(projectIds)).all<{ id: string; projectId: string; name: string; placeholder: string; hostsJson: string; updatedAt: string }>()).results
  const byProject = new Map<string, EgressSecret[]>()
  for (const { projectId, hostsJson, ...secret } of rows) byProject.set(projectId, [...byProject.get(projectId) ?? [], { ...secret, hosts: JSON.parse(hostsJson) as string[] }])
  return byProject
}

/** The windows still open for these boxes, and each box's latest plan if it was approved. */
async function approvalsOf(env: L4Env, boxIds: string[], now: string) {
  const rows = (await env.DB.prepare(`SELECT box_id AS boxId,kind,status,request_json AS requestJson,expires_at AS expiresAt FROM factory_approvals
    WHERE box_id IN (SELECT value FROM json_each(?)) AND ((kind='window' AND status='approved' AND expires_at>?) OR kind='plan') ORDER BY created_at DESC,id DESC`)
    .bind(JSON.stringify(boxIds), now).all<{ boxId: string; kind: string; status: string; requestJson: string; expiresAt: string }>()).results
  const windows = new Map<string, EgressWindow[]>(), plans = new Map<string, { hosts: string[]; secrets: string[] } | null>()
  for (const row of rows) {
    const request = JSON.parse(row.requestJson) as { host?: string; hosts?: string[]; secrets?: string[] }
    if (row.kind === 'window') windows.set(row.boxId, [...windows.get(row.boxId) ?? [], { host: request.host!, secrets: request.secrets ?? [], expiresAt: row.expiresAt }])
    // Only the latest plan counts; a newer one waiting for a decision covers nothing yet.
    else if (!plans.has(row.boxId)) plans.set(row.boxId, row.status === 'approved' ? { hosts: request.hosts ?? [], secrets: request.secrets ?? [] } : null)
  }
  return { windows, plans }
}

/** The compiled egress of each box, as a sync hands it to the box's Node and BoxOutbound enforces it. */
export async function boxEgress(env: L4Env, boxIds: string[]): Promise<Map<string, CompiledEgress>> {
  const compiled = new Map<string, CompiledEgress>()
  if (!boxIds.length) return compiled
  const now = nowIso(), boxes = await projectsOf(env, boxIds)
  const live = (box: BoxRow) => box.projectId && !box.archivedAt ? box.projectId : null
  const [secrets, { windows, plans }] = await Promise.all([projectEgressSecrets(env, [...new Set(boxes.flatMap(box => live(box) ?? []))]), approvalsOf(env, boxIds, now)])
  for (const box of boxes) {
    const projectId = live(box)
    const mode = box.mandateJson ? (JSON.parse(box.mandateJson) as RunMandate).execution?.mode ?? 'review' : 'review'
    compiled.set(box.id, await compileEgress({ projectId, serverHosts: serverHosts(env), network: projectId ? projectNetwork(box.factoryJson) : { presets: [], hosts: [] },
      secrets: projectId ? secrets.get(projectId) ?? [] : [], windows: projectId ? windows.get(box.id) ?? [] : [], plan: plans.get(box.id) ?? null, mode, now }))
  }
  return compiled
}

/** The values of the secrets in effect, decrypted only for the box's egress layer. */
export async function egressSecretValues(env: L4Env, egress: CompiledEgress, host?: string) {
  const wanted = egress.secrets.filter(secret => !host || secret.hosts.includes(host))
  if (!wanted.length) return []
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server credential encryption is unavailable')
  const rows = (await env.DB.prepare('SELECT id,secret_ciphertext AS ciphertext,secret_iv AS iv,secret_version AS version FROM project_secrets WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(wanted.map(secret => secret.id))).all<{ id: string; ciphertext: string; iv: string; version: number }>()).results
  const byId = new Map(rows.map(row => [row.id, row]))
  const values = []
  for (const secret of wanted) {
    const row = byId.get(secret.id)
    if (row) values.push({ id: secret.id, placeholder: secret.placeholder, hosts: secret.hosts, value: await decryptSecret(env.AUTH_SECRET, `project-secret:${secret.id}`, row) })
  }
  return values
}
export async function markSecretsUsed(env: L4Env, ids: string[]) {
  if (ids.length) await env.DB.prepare('UPDATE project_secrets SET last_used_at=? WHERE id IN (SELECT value FROM json_each(?))').bind(nowIso(), JSON.stringify(ids)).run()
}

/** What the Agent reads when a request carried a placeholder that is not put in at this host. */
export function placeholderRefusal(placeholder: string, host: string, known: KnownPlaceholder[]) {
  const secret = known.find(entry => entry.placeholder === placeholder)
  if (secret && !secret.hosts.includes(host)) return `${placeholder} is not bound to ${host}; it is bound to ${secret.hosts.join(', ')}. Ask a person to bind it to ${host} in the Project’s Secrets. The request was not sent.`
  return `${placeholder} is not open for ${host} for this Task. Ask with request_network_window {"host":"${host}","secrets":["${secret?.name ?? placeholder.slice('L4_SECRET_'.length)}"]}; a person may have to approve it. The request was not sent.`
}

/**
 * Puts each placeholder in effect at this host in place of its value. A body is read byte for byte (latin1), so
 * it keeps every other byte as it was; in a URL the value is percent-encoded where a URL needs it. The first
 * known placeholder that is not in effect here refuses the whole request instead.
 */
export function replacePlaceholders(text: string, host: string, values: Array<{ placeholder: string; hosts: string[]; value: string }>, known: KnownPlaceholder[], as: 'header' | 'url' | 'body' = 'header'): { refused: string } | { text: string; changed: boolean } {
  const encode = as === 'body' ? latin1 : as === 'url' ? (value: string) => value.replace(/[^A-Za-z0-9\-._~:@!$&'()*+,;=]/gu, encodeURIComponent) : (value: string) => value
  const usable = new Map(values.filter(secret => secret.hosts.includes(host)).map(secret => [secret.placeholder, encode(secret.value)]))
  const placeholders = new Set(known.map(secret => secret.placeholder))
  let refused: string | null = null
  const replaced = text.replace(PLACEHOLDER_PATTERN, token => {
    if (!placeholders.has(token)) return token
    const value = usable.get(token)
    if (value !== undefined) return value
    refused ??= token
    return token
  })
  return refused ? { refused: placeholderRefusal(refused, host, known) } : { text: replaced, changed: replaced !== text }
}
/** A UTF-8 value as the latin1 string of its bytes. */
const latin1 = (value: string) => String.fromCharCode(...new TextEncoder().encode(value))

const bytesOf = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0))
const textOf = (bytes: Uint8Array) => { let text = ''; for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192)); return text }
/** A body as latin1 text, byte for byte, and back. */
export const egressBytes = { text: textOf, bytes: (text: string) => bytesOf(text) as Uint8Array<ArrayBuffer> }
/** Takes every value out of a response again, also where one spans two chunks, so the box never reads one back. */
export function scrubStream(values: Array<{ placeholder: string; value: string }>) {
  const pairs = values.map(secret => ({ value: latin1(secret.value), placeholder: secret.placeholder })).sort((a, b) => b.value.length - a.value.length)
  const keep = Math.max(0, ...pairs.map(pair => pair.value.length - 1))
  const clean = (text: string) => pairs.reduce((result, pair) => result.split(pair.value).join(pair.placeholder), text)
  let tail = ''
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = clean(tail + textOf(chunk))
      if (text.length > keep) { controller.enqueue(bytesOf(text.slice(0, text.length - keep))); tail = text.slice(text.length - keep) } else tail = text
    },
    flush(controller) { if (tail) controller.enqueue(bytesOf(tail)) },
  })
}
export const scrubText = (text: string, values: Array<{ placeholder: string; value: string }>) => values.reduce((result, secret) => result.split(secret.value).join(secret.placeholder), text)
/** Text bodies have their placeholders put in; others pass as they came. */
export const TEXT_BODY = /^(?:text\/|multipart\/form-data|application\/(?:json|x-www-form-urlencoded|xml|javascript|graphql|x-ndjson|[\w.+-]+\+(?:json|xml)))/iu
export const EGRESS_BODY_LIMIT = 1048576

/** What the Agent is told of its box's screen and browser (a box on a Docker Node or L4 Compute has them; one on Cloudflare does not). */
export const BOX_SCREEN_BRIEF = 'This box has a screen and a browser: DISPLAY=:99 (1280x720) is set in your shell, and Chromium is /usr/bin/chromium. '
  + 'Test a web game the way a player sees it: serve it in the box (for example python3 -m http.server 8000 &) and open it with '
  + 'chromium --window-position=0,0 --window-size=1280,720 http://localhost:8000 &, or drive it with Playwright: playwright-core is installed '
  + "(in a .cjs script, require('playwright-core').chromium.launch({ executablePath: '/usr/bin/chromium', headless: false })), which also gives you screenshots and console errors. "
  + 'Close the browser when you are done.'
/** Where a person may watch the box (L4 Compute): the Agent should know its screen is not private. */
export const BOX_WATCHED_BRIEF = 'The person who asked for this work may be watching this screen live. Keep what you open there on the work, and show the game running when it does.'

/**
 * What a box turn's Agent is told about its box, beside the tools: the Project secrets it may send as
 * placeholders (the egress layer puts each value in only at its bound hosts), the repository its checkout came
 * from (the checkout itself keeps no remote), its screen and browser and whether someone may watch them, and the
 * plain settings a partner left for its Agents.
 */
export async function boxRunBrief(env: L4Env, run: { mandateJson: string; environmentJson: string | null }): Promise<string> {
  const projectId = (JSON.parse(run.mandateJson) as RunMandate).projectId
  const environment = run.environmentJson ? JSON.parse(run.environmentJson) as { remote?: string; computeNodeId?: string } : null
  const secrets = projectId ? (await projectEgressSecrets(env, [projectId])).get(projectId) ?? [] : []
  const project = projectId ? await env.DB.prepare('SELECT factory_json AS factoryJson FROM projects WHERE id=?').bind(projectId).first<{ factoryJson: string | null }>() : null
  const open = project ? networkHosts(projectNetwork(project.factoryJson)) : []
  const { readPartnerConfig } = await import('./cloud-seed')
  const partner = await readPartnerConfig(env)
  const node = environment?.computeNodeId
    ? await env.DB.prepare("SELECT json_extract(capabilities_json,'$.provider') AS provider FROM compute_nodes WHERE id=?").bind(environment.computeNodeId).first<{ provider: string | null }>()
    : null
  const lines = [
    ...(environment?.remote ? [`This box's repository: ${environment.remote} (the checkout keeps no remote; publish commits with factory_publish).`] : []),
    ...(node && node.provider !== 'cloudflare-containers' ? [BOX_SCREEN_BRIEF, ...(node.provider === 'l4-compute' ? [BOX_WATCHED_BRIEF] : [])] : []),
    ...(open.length ? [`Hosts this box reaches without asking, its Project's network: ${open.join(', ')}. Ask with request_network_window only for another host.`] : []),
    ...(secrets.length ? ['Project secrets in this box, as placeholders: send the placeholder, and the box puts the value in only on its way to the hosts named. Never try to read a value.',
      ...secrets.map(secret => `- ${secret.name}=${secret.placeholder} (put in for ${secret.hosts.join(', ')})`)] : []),
    ...(partner && Object.keys(partner.env).length ? ['Settings for this Server\'s Agents:', ...Object.entries(partner.env).map(([key, value]) => `- ${key}=${value}`)] : []),
  ]
  return lines.length ? `\n${lines.join('\n')}` : ''
}
