import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createTarStream, textEntry } from '../../server/utils/backup-format'
import { verifyUpdateArchive } from '../../scripts/server-update.mjs'

it('restores the persisted SQL archive and validates file payloads before deployment', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'l4-archive-test-'))
  const now = new Date()
  const fileBytes = 'private attachment'
  const schema = ['server', 'server_identity', 'auth_users', 'auth_accounts', 'users', 'roles', 'channels', 'messages'].map(name => `CREATE TABLE ${name}(id TEXT PRIMARY KEY); INSERT INTO ${name} VALUES('server-id');`).join('\n') + "CREATE TABLE server_schema(version TEXT);INSERT INTO server_schema VALUES('server-v1');"
  async function archive(etag: string) {
    const entries = [
      textEntry('database/000000-schema.sql', schema, now),
      textEntry('r2/00000001.json', JSON.stringify({ key: 'private/file', size: Buffer.byteLength(fileBytes), etag }), now),
      textEntry('r2/00000001.bin', fileBytes, now),
      textEntry('summary.json', JSON.stringify({ r2Objects: 1 }), now),
    ]
    const bytes = Buffer.from(await new Response(createTarStream((async function* () { yield* entries })())).arrayBuffer())
    const path = resolve(directory, 'backup.tar'); await writeFile(path, bytes)
    return { path, receipt: { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  }
  try {
    let a = await archive(createHash('md5').update(fileBytes).digest('hex'))
    const proof = await verifyUpdateArchive(a.path, a.receipt, 'server-id')
    expect(proof.objects).toEqual([expect.objectContaining({ key: 'private/file', size: fileBytes.length })])
    expect(proof.fingerprints.some((t: { name: string }) => t.name === 'auth_users')).toBe(true)
    await expect(verifyUpdateArchive(a.path, a.receipt, 'foreign-server')).rejects.toThrow()
    await expect(verifyUpdateArchive(a.path, { ...a.receipt, sha256: '0'.repeat(64) }, 'server-id')).rejects.toThrow()
    a = await archive('0'.repeat(32))
    await expect(verifyUpdateArchive(a.path, a.receipt, 'server-id')).rejects.toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
