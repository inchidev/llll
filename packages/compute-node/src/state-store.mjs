import { DatabaseSync } from 'node:sqlite'
import { mkdir, chmod, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const capability = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export function serverOrigin(value) {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS Server origin, or local loopback for development')
  return url.origin
}
function connectionRecord(server, value) {
  if (!value || !uuid(value.nodeId) || !uuid(value.serverId) || !capability(value.token)) throw new Error('Invalid Node pairing response')
  return { server: serverOrigin(server), nodeId: value.nodeId, serverId: value.serverId, token: value.token }
}
function receiptRecord(value) {
  const result = value?.result
  if (value?.operation !== 'result' || !uuid(value.id) || !capability(value.lease) || !result
    || typeof result.ok !== 'boolean' || !Number.isSafeInteger(result.exitCode) || result.exitCode < -1 || result.exitCode > 255
    || typeof result.output !== 'string' || result.output.length > 64000
    || !Number.isSafeInteger(result.runtimeMs) || result.runtimeMs < 0 || result.runtimeMs > 180000) throw new Error('Invalid retained receipt')
  const saved = { ok: result.ok, exitCode: result.exitCode, output: result.output, runtimeMs: result.runtimeMs }
  if (result.snapshot !== undefined) {
    if (!result.snapshot || typeof result.snapshot !== 'object' || Array.isArray(result.snapshot) || Buffer.byteLength(JSON.stringify(result.snapshot)) > 340000) throw new Error('Invalid retained snapshot')
    saved.snapshot = result.snapshot
  }
  if (Buffer.byteLength(JSON.stringify(saved)) > 400000) throw new Error('Receipt size limit reached')
  return { operation: 'result', id: value.id, lease: value.lease, result: saved }
}

/** One private, bounded, transactional journal; never executes restored data. */
export async function openNodeState(directory) {
  await mkdir(directory,{recursive:true,mode:0o700})
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw new Error('Unsafe Node state directory')
  await chmod(directory,0o700)
  const path = join(directory,'node-state.sqlite')
  try { const file = await open(path,'wx',0o600); await file.close() } catch(error) { if (error.code !== 'EEXIST') throw error }
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 67108864) throw new Error('Unsafe Node state database')
  await chmod(path,0o600)
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=16384;
    CREATE TABLE IF NOT EXISTS connection(singleton INTEGER PRIMARY KEY CHECK(singleton=1),server TEXT NOT NULL,node_id TEXT NOT NULL,server_id TEXT NOT NULL,token TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,lease TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;`)
  return {
    connection(server) {
      const row = db.prepare('SELECT server,node_id AS nodeId,server_id AS serverId,token FROM connection WHERE singleton=1').get()
      if (!row) return null
      if (row.server !== serverOrigin(server)) throw new Error('Node state belongs to a different Server origin')
      return connectionRecord(server,row)
    },
    pair(server, value) {
      const record = connectionRecord(server,value)
      db.prepare('INSERT INTO connection(singleton,server,node_id,server_id,token) VALUES(1,?,?,?,?)').run(record.server,record.nodeId,record.serverId,record.token)
    },
    retain(value) {
      const saved = receiptRecord(value), encoded = JSON.stringify(saved.result)
      db.exec('BEGIN IMMEDIATE')
      try {
        const before = db.prepare('SELECT lease,result_json FROM receipts WHERE id=?').get(saved.id)
        if (before && (before.lease !== saved.lease || before.result_json !== encoded)) throw new Error('Receipt identity changed')
        if (!before) {
          if (db.prepare('SELECT count(*) AS total FROM receipts').get().total >= 128) throw new Error('Retained receipt capacity reached')
          db.prepare('INSERT INTO receipts(id,lease,result_json,created_at) VALUES(?,?,?,?)').run(saved.id,saved.lease,encoded,Date.now())
        }
        db.exec('COMMIT')
      } catch(error) { db.exec('ROLLBACK'); throw error }
    },
    receipts() {
      return db.prepare('SELECT id,lease,result_json FROM receipts ORDER BY created_at,id LIMIT 128').all()
        .map(row => receiptRecord({ operation:'result',id:row.id,lease:row.lease,result:JSON.parse(row.result_json) }))
    },
    acknowledge(id,lease) { db.prepare('DELETE FROM receipts WHERE id=? AND lease=?').run(id,lease) },
    close() { db.close() },
  }
}
