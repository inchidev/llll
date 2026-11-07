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
    CREATE TABLE IF NOT EXISTS local_pairing(singleton INTEGER PRIMARY KEY CHECK(singleton=1),server TEXT NOT NULL,node_id TEXT NOT NULL,token TEXT NOT NULL) STRICT;
    DROP TABLE IF EXISTS receipts;
    CREATE TABLE IF NOT EXISTS boxes(id TEXT PRIMARY KEY,lease TEXT NOT NULL,task_id TEXT NOT NULL,ready INTEGER NOT NULL,runtime_ms INTEGER NOT NULL) STRICT;`)
  return {
    connection(server) {
      const row = db.prepare('SELECT server,node_id AS nodeId,server_id AS serverId,token FROM connection WHERE singleton=1').get()
      if (!row) return null
      if (row.server !== serverOrigin(server)) throw new Error('Node state belongs to a different Server origin')
      return connectionRecord(server,row)
    },
    localPairing(server) {
      const origin = serverOrigin(server)
      let row = db.prepare('SELECT server,node_id AS nodeId,token FROM local_pairing WHERE singleton=1').get()
      if (!row) {
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2,'0')).join('')
        db.prepare('INSERT INTO local_pairing(singleton,server,node_id,token) VALUES(1,?,?,?)').run(origin,crypto.randomUUID(),token)
        row = db.prepare('SELECT server,node_id AS nodeId,token FROM local_pairing WHERE singleton=1').get()
      }
      if (row.server !== origin || !uuid(row.nodeId) || !capability(row.token)) throw new Error('Invalid local pairing intent or Server origin')
      return { nodeId: row.nodeId, token: row.token }
    },
    pair(server, value) {
      const record = connectionRecord(server,value)
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('INSERT INTO connection(singleton,server,node_id,server_id,token) VALUES(1,?,?,?,?)').run(record.server,record.nodeId,record.serverId,record.token)
        db.prepare('DELETE FROM local_pairing WHERE server=? AND node_id=? AND token=?').run(record.server,record.nodeId,record.token)
        db.exec('COMMIT')
      } catch(error) { db.exec('ROLLBACK'); throw error }
    },
    /** The boxes whose disks this Node holds, with the lease each last held and how long it has run. */
    boxes: {
      list() {
        return db.prepare('SELECT id,lease,task_id AS taskId,ready,runtime_ms AS runtimeMs FROM boxes ORDER BY id LIMIT 512').all()
          .filter(row => uuid(row.id) && capability(row.lease) && uuid(row.taskId)).map(row => ({ ...row, ready: row.ready === 1 }))
      },
      save(box) {
        if (!uuid(box.id) || !capability(box.lease) || !uuid(box.taskId) || !Number.isSafeInteger(box.runtimeMs) || box.runtimeMs < 0) throw new Error('Invalid box record')
        db.prepare('INSERT INTO boxes(id,lease,task_id,ready,runtime_ms) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lease=excluded.lease,ready=excluded.ready,runtime_ms=excluded.runtime_ms')
          .run(box.id,box.lease,box.taskId,box.ready?1:0,box.runtimeMs)
      },
      forget(id) { db.prepare('DELETE FROM boxes WHERE id=?').run(id) },
    },
    close() { db.close() },
  }
}
