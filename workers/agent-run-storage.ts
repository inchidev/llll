/** Keep large Run archives in bounded SQLite rows, separate from the Pi tables. */
const CHUNK_CHARS = 24_000
function initialize(storage: DurableObjectStorage): void {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS l4_run_blobs (name TEXT NOT NULL,chunk INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(name,chunk))')
}
export async function putRunBlob(storage: DurableObjectStorage, key: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value)
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length;) {
    let end = Math.min(offset + CHUNK_CHARS, encoded.length)
    // SQLite encodes strings as UTF-8; never split a surrogate pair between rows.
    const last = encoded.charCodeAt(end - 1)
    if (end < encoded.length && last >= 0xD800 && last <= 0xDBFF) end--
    chunks.push(encoded.slice(offset, end)); offset = end
  }
  if (chunks.length > 120) throw new Error('Run archive exceeds its storage limit')
  initialize(storage)
  storage.transactionSync(() => {
    storage.sql.exec('DELETE FROM l4_run_blobs WHERE name=?', key)
    for (let index = 0; index < chunks.length; index++) {
      storage.sql.exec('INSERT INTO l4_run_blobs(name,chunk,value) VALUES(?,?,?)', key, index, chunks[index]!)
    }
  })
}
export async function getRunBlob<T>(storage: DurableObjectStorage, key: string): Promise<T | undefined> {
  initialize(storage)
  const rows = storage.sql.exec<{ chunk: number; value: string }>('SELECT chunk,value FROM l4_run_blobs WHERE name=? ORDER BY chunk', key).toArray()
  // Supports active Runs created before chunked archives were introduced.
  if (!rows.length) return storage.get<T>(key)
  if (rows.length > 120 || rows.some((row, index) => row.chunk !== index)) throw new Error('Run archive is incomplete')
  return JSON.parse(rows.map(row => row.value).join('')) as T
}
export async function deleteRunBlob(storage: DurableObjectStorage, key: string): Promise<void> {
  initialize(storage)
  storage.sql.exec('DELETE FROM l4_run_blobs WHERE name=?', key)
  await storage.delete(key)
}
