const encoder = new TextEncoder()
const TAR_BLOCK_BYTES = 512

export type TarEntry = {
  path: string
  size: number
  modifiedAt: Date
  body: Uint8Array | ReadableStream<Uint8Array>
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value)
  if (bytes.byteLength > length) throw new Error(`TAR field is too long: ${value}`)
  target.set(bytes, offset)
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const octal = Math.max(0, Math.floor(value)).toString(8)
  if (octal.length > length - 1) throw new Error(`TAR numeric field is too large: ${value}`)
  writeAscii(target, offset, length, `${octal.padStart(length - 1, '0')}\0`)
}

export function tarHeader(path: string, size: number, modifiedAt: Date): Uint8Array {
  if (!path || encoder.encode(path).byteLength > 100) throw new Error(`Invalid TAR path: ${path}`)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid TAR entry size: ${size}`)

  const header = new Uint8Array(TAR_BLOCK_BYTES)
  writeAscii(header, 0, 100, path)
  writeOctal(header, 100, 8, 0o600)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, Math.floor(modifiedAt.getTime() / 1000))
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeAscii(header, 257, 6, 'ustar\0')
  writeAscii(header, 263, 2, '00')
  writeAscii(header, 265, 32, 'llll')
  writeAscii(header, 297, 32, 'llll')

  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

async function pipeEntry(writer: WritableStreamDefaultWriter<Uint8Array>, entry: TarEntry) {
  await writer.write(tarHeader(entry.path, entry.size, entry.modifiedAt))
  let written = 0

  if (entry.body instanceof Uint8Array) {
    written = entry.body.byteLength
    if (written) await writer.write(entry.body)
  }
  else {
    const reader = entry.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        written += value.byteLength
        await writer.write(value)
      }
    }
    finally {
      reader.releaseLock()
    }
  }

  if (written !== entry.size) throw new Error(`TAR entry size changed for ${entry.path}`)
  const padding = (TAR_BLOCK_BYTES - (written % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
  if (padding) await writer.write(new Uint8Array(padding))
}

export function createTarStream(entries: AsyncIterable<TarEntry>): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  void (async () => {
    try {
      for await (const entry of entries) await pipeEntry(writer, entry)
      await writer.write(new Uint8Array(TAR_BLOCK_BYTES * 2))
      await writer.close()
    }
    catch (error) {
      await writer.abort(error)
    }
  })()
  return readable
}

export function textEntry(path: string, value: string, modifiedAt: Date): TarEntry {
  const body = encoder.encode(value)
  return { path, size: body.byteLength, modifiedAt, body }
}

export function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function bytesHex(value: Uint8Array) {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return `X'${bytesHex(new Uint8Array(value))}'`
  if (value instanceof ArrayBuffer) return `X'${bytesHex(new Uint8Array(value))}'`
  if (ArrayBuffer.isView(value)) return `X'${bytesHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}'`

  const text = String(value)
  if (text.includes('\0')) return `CAST(X'${bytesHex(encoder.encode(text))}' AS TEXT)`
  return `'${text.replaceAll("'", "''")}'`
}


const BACKUP_RESTORE_VALUES_TABLE = '__llll_restore_values'
const MAX_RESTORE_STATEMENT_BYTES = 90_000
const RESTORE_VALUE_CHUNK_BYTES = 24_000

/** Stage oversized values before inserting the complete row with its constraints. */
export function sqlInsertStatements(table: string, columns: string[], row: Record<string, unknown>): string[] {
  const target = sqlIdentifier(table)
  const names = columns.map(sqlIdentifier).join(', ')
  const prefix = `INSERT INTO ${target} (${names}) VALUES `
  const insert = `${prefix}(${columns.map(column => sqlValue(row[column])).join(', ')});`
  if (encoder.encode(insert).byteLength <= MAX_RESTORE_STATEMENT_BYTES) return [insert]

  const scratch = sqlIdentifier(BACKUP_RESTORE_VALUES_TABLE)
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${scratch} (column_index INTEGER PRIMARY KEY, value);`,
    `DELETE FROM ${scratch};`,
  ]
  const values: string[] = []
  for (const [index, column] of columns.entries()) {
    const value = row[column]
    const literal = sqlValue(value)
    if (encoder.encode(literal).byteLength <= RESTORE_VALUE_CHUNK_BYTES) {
      statements.push(`INSERT INTO ${scratch} VALUES (${index}, ${literal});`)
      values.push(`(SELECT value FROM ${scratch} WHERE column_index = ${index})`)
      continue
    }

    const isText = typeof value === 'string'
    const bytes = isText ? encoder.encode(value)
      : value instanceof ArrayBuffer ? new Uint8Array(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(value as number[])
    statements.push(`INSERT INTO ${scratch} VALUES (${index}, X'');`)
    for (let offset = 0; offset < bytes.byteLength; offset += RESTORE_VALUE_CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + RESTORE_VALUE_CHUNK_BYTES)
      statements.push(`UPDATE ${scratch} SET value = CAST(value || ${sqlValue(part)} AS BLOB) WHERE column_index = ${index};`)
    }
    // Accumulate bytes as BLOB so chunks may safely split a UTF-8 sequence or
    // contain NUL; decode only once the complete text value has been rebuilt.
    values.push(`(SELECT ${isText ? 'CAST(value AS TEXT)' : 'value'} FROM ${scratch} WHERE column_index = ${index})`)
  }
  statements.push(`${prefix}(${values.join(', ')});`, `DROP TABLE ${scratch};`)
  return statements
}
