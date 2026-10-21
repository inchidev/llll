import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { requireWorkersBuild } from './ci-only.mjs'
import { validateReleaseManifest } from './release-artifacts.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fingerprint = rows => digest(rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort().join('\n'))
const quote = value => '"' + value.replaceAll('"', '""') + '"'
const canonicalRow = row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Array.from(value) : value])))
async function tableHash(readPage) {
  const hash = createHash('sha256')
  for (let offset = 0;; offset += 50) {
    const rows = await readPage(offset)
    for (const row of rows) hash.update(canonicalRow(row) + '\n')
    if (rows.length < 50) break
  }
  return hash.digest('hex')
}
const objectPath = (bucket, key) => `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`

/** Verify the persisted archive from disk, with bounded memory for file payloads. */
export async function verifyUpdateArchive(path, receipt, serverId) {
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length }
  assert.equal(bytes, receipt.sizeBytes); assert.equal(hash.digest('hex'), receipt.sha256)
  const file = await open(path, 'r'), entries = new Map(), databasePath = `${path}.${crypto.randomUUID()}.sqlite`, restored = new DatabaseSync(databasePath)
  try {
    for (let offset = 0; offset + 512 <= bytes;) {
      const header = Buffer.alloc(512); await file.read(header, 0, 512, offset)
      if (header.every(x => x === 0)) break
      const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '')
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0
      assert.ok(size >= 0 && offset + 512 + size <= bytes && !entries.has(name))
      entries.set(name, { start: offset + 512, size })
      offset += 512 + Math.ceil(size / 512) * 512
    }
    async function text(name) {
      const entry = entries.get(name); assert.ok(entry && entry.size <= 32 * 1024 * 1024)
      const value = Buffer.alloc(entry.size); await file.read(value, 0, value.length, entry.start)
      return value.toString()
    }
    const summary = JSON.parse(await text('summary.json'))
    restored.exec('PRAGMA foreign_keys=ON; BEGIN;')
    for (const name of [...entries.keys()].filter(n => /^database\/.*\.sql$/.test(n)).sort()) restored.exec(await text(name))
    restored.exec('COMMIT;')
    assert.equal(restored.prepare('SELECT id FROM server').get().id, serverId)
    assert.equal(restored.prepare('SELECT version FROM server_schema').get().version, 'server-v1')
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
    const objects = []
    for (const name of entries.keys()) if (/^r2\/.*\.json$/.test(name)) {
      const meta = JSON.parse(await text(name)), body = entries.get(name.replace(/\.json$/, '.bin'))
      assert.ok(body); assert.equal(body.size, meta.size)
      if (/^[a-f0-9]{32}$/.test(meta.etag)) {
        const md5 = createHash('md5')
        if (body.size) for await (const chunk of createReadStream(path, { start: body.start, end: body.start + body.size - 1 })) md5.update(chunk)
        assert.equal(md5.digest('hex'), meta.etag)
      }
      objects.push({ key: meta.key, etag: meta.etag, size: meta.size })
    }
    assert.equal(objects.length, summary.r2Objects)
    const fingerprints = []
    for (const table of restored.prepare('PRAGMA table_list').all().filter(t => ['table', 'virtual'].includes(t.type) && !/^(sqlite_|_cf_)/.test(t.name) && t.name !== 'server_update_control')) {
      const columns = restored.prepare(`PRAGMA table_info(${quote(table.name)})`).all()
      const primary = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk)
      const order = (primary.length ? primary : columns).map(c => quote(c.name)).join(',')
      const sql = `SELECT * FROM ${quote(table.name)} ORDER BY ${order} LIMIT 50 OFFSET `
      fingerprints.push({ name: table.name, sql, sha256: await tableHash(async offset => restored.prepare(sql + offset).all()) })
    }
    return { fingerprints, objects }
  } finally { restored.close(); await file.close(); await rm(databasePath, { force: true }) }
}

export async function runPendingServerUpdate({ token, accountId, workerName, origin }) {
  requireWorkersBuild()
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`
  const headers = { Authorization: `Bearer ${token}` }
  async function raw(path, options = {}) {
    return fetch(base + path, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(120000) })
  }
  async function api(path, options = {}) {
    const r = await raw(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
    if (!r.ok) throw new Error(`Cloudflare ${options.method || 'GET'} failed (${r.status})`)
    const data = await r.json(); if (!data.success) throw new Error('Cloudflare operation failed')
    return data
  }
  const settingsResponse = await raw(`/workers/scripts/${workerName}/settings`)
  if (settingsResponse.status === 404) return false
  if (!settingsResponse.ok) throw new Error('Cannot inspect Server settings')
  const settings = (await settingsResponse.json()).result
  const bindings = settings.bindings
  const db = bindings.find(b => b.name === 'DB')?.id
  const files = bindings.find(b => b.name === 'FILES')?.bucket_name
  const backups = bindings.find(b => b.name === 'BACKUPS')?.bucket_name
  if (!db || !backups) return false
  assert.ok(files && backups !== files, 'Update backup bucket must be separate from live files')
  const configuredOrigin = bindings.find(b => b.name === 'PUBLIC_ORIGIN')?.text || `https://${bindings.find(b => b.name === 'LLLL_APP_HOSTNAME')?.text}`
  assert.equal(origin, configuredOrigin, 'Build origin does not match this Worker')
  async function query(sql, params = []) {
    const d = await api(`/d1/database/${db}/query`, { method: 'POST', body: JSON.stringify({ sql, params }) })
    assert.ok(d.result.every(s => s.success !== false)); return d.result.flatMap(s => s.results || [])
  }
  async function fileInventory() {
    const objects = []; let cursor
    do {
      const query = new URLSearchParams({ per_page: '1000', ...(cursor ? { cursor } : {}) })
      const d = await api(`/r2/buckets/${files}/objects?${query}`)
      objects.push(...d.result.map(o => ({ key: o.key, etag: o.etag.replace(/^"|"$/g, ''), size: o.size })))
      cursor = d.result_info?.is_truncated ? d.result_info.cursor : undefined
    } while (cursor)
    return objects
  }
  const serverId = (await query('SELECT id FROM server LIMIT 1'))[0]?.id
  if (!serverId) return false
  // Pre-feature Servers are unchanged until an operator first adopts the migration/runtime.
  if (!(await query("SELECT name FROM sqlite_master WHERE type='table' AND name='server_update_control'")).length) return false
  const bundlePath = resolve('.deployment/builds/update-state.mjs')
  await build({ stdin: { contents: `export * from './shared/server-updates.ts';export * from './shared/server-update-runner.ts';export * from './shared/server-update-store.ts'`, resolveDir: process.cwd() }, outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', target: 'node24' })
  const { executeServerUpdate, createUpdateStore } = await import(pathToFileURL(bundlePath).href)
  const store = createUpdateStore(query)
  const corePath = resolve('.deployment/builds/deployment-core.mjs')
  await build({ entryPoints: ['packages/deployment-core/src/index.ts'], outfile: corePath, bundle: true, platform: 'node', format: 'esm', target: 'node24' })
  const core = await import(pathToFileURL(corePath).href)
  let release, before, snapshot
  async function identity() {
    const r = await fetch(`${origin}/.well-known/llll?update=${Date.now()}`, { signal: AbortSignal.timeout(15000), redirect: 'error' })
    assert.ok(r.ok); const d = await r.json(); assert.equal(d.id, serverId); assert.equal(d.origin, origin); assert.equal(d.ready, true)
    return d
  }
  return executeServerUpdate({
    store, serverId, buildId: process.env.WORKERS_CI_BUILD_UUID,
    installedVersion: async () => { before = await identity(); return before.version },
    previousBuildStopped: async id => (await api(`/builds/builds/${id}`)).result.status === 'stopped',
    async prepare(target) {
      const tag = `v${target}`, url = `https://github.com/inchidev/llll/releases/download/${tag}`
      const manifestResponse = await fetch(`${url}/llll-release.json`, { signal: AbortSignal.timeout(30000) }); assert.ok(manifestResponse.ok)
      const manifest = await manifestResponse.json(); validateReleaseManifest(manifest, tag, manifest.commit)
      const refs = execFileSync('git', ['ls-remote', '--tags', 'https://github.com/inchidev/llll.git', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 }).trim().split('\n').map(line => line.split(/\s+/))
      const commit = (refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`) || refs.find(([, ref]) => ref === `refs/tags/${tag}`))?.[0]
      assert.equal(commit, manifest.commit, 'Published tag does not match release provenance')
      release = await core.loadL4Release(`${url}/llll-cloudflare-manifest.json`)
      assert.equal(release.manifest.version, target)
      for (const [name, entry] of [['llll-worker.mjs', release.manifest.worker], ['llll-assets.json', release.manifest.assets]]) {
        assert.equal(entry.url, `${url}/${name}`); assert.equal(entry.sha256, manifest.files[name].sha256); assert.equal(entry.size, manifest.files[name].size)
      }
      console.log(JSON.stringify({ step: 'release-verified', version: target, commit: manifest.commit }))
    },
    async backup(job) {
      const record = (await store.read()).value
      const result = await fetch(`${origin}/api/servers/${serverId}/updates/backup`, { method: 'POST', headers: { Authorization: `Bearer ${record.backupToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: job.id, buildId: process.env.WORKERS_CI_BUILD_UUID }), redirect: 'error', signal: AbortSignal.timeout(30 * 60 * 1000) })
      assert.ok(result.ok, 'Pre-update backup did not finish')
      const receipt = (await result.json()).backup
      assert.equal(receipt.bucket, backups); assert.ok(receipt.key.startsWith(`servers/${serverId}/pre-update/${job.id}/`))
      const directory = await mkdtemp(resolve(tmpdir(), 'llll-update-'))
      try {
        const saved = await raw(objectPath(backups, receipt.key)); assert.ok(saved.ok && saved.body)
        const file = resolve(directory, 'backup.tar')
        await pipeline(Readable.fromWeb(saved.body), createWriteStream(file, { mode: 0o600 }))
        snapshot = await verifyUpdateArchive(file, receipt, serverId)
        for (const table of snapshot.fingerprints) assert.equal(await tableHash(offset => query(table.sql + offset)), table.sha256, 'Server data changed during backup; retry when activity is lower')
        assert.equal(fingerprint(await fileInventory()), fingerprint(snapshot.objects), 'Files changed during backup; retry when activity is lower')
        console.log(JSON.stringify({ step: 'backup-verified', serverId, key: receipt.key, sizeBytes: receipt.sizeBytes, sha256: receipt.sha256 }))
        return { ...receipt, verified: true }
      } finally { await rm(directory, { recursive: true, force: true }) }
    },
    async deploy(target) {
      assert.equal((await identity()).version, before.version, 'Another operator changed the installed version')
      const result = await core.deployL4Update(token, accountId, workerName, release)
      assert.equal(result.version, target)
    },
    async verify(job) {
      const after = await identity(); assert.equal(after.version, job.targetVersion)
      if (before) { assert.equal(after.name, before.name); assert.equal(after.iconUrl, before.iconUrl) }
      console.log(JSON.stringify({ step: 'update-verified', id: after.id, version: after.version }))
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runPendingServerUpdate({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, workerName: process.env.LLLL_SERVER_WORKER, origin: process.env.LLLL_SERVER_ORIGIN })
}
