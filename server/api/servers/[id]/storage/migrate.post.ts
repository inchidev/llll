import { updateOwner } from '../../../../utils/server-updates'
import { fail } from '../../../../utils/cf'
import { writeServerSetting } from '../../../../../shared/server-settings'

/** A resumable, explicit copy. Basic writes pause; reads keep using the original KV objects. */
export default defineEventHandler(async event => {
  const { env } = await updateOwner(event)
  if (!env.FILES || !env.TICKETS) fail(409, 'r2_unavailable', 'Connect R2 before migrating files')
  await writeServerSetting(env.DB, 'storage.migration', 'r2')
  const abandoned = (await env.DB.prepare('DELETE FROM file_uploads WHERE created_at<? RETURNING id').bind(new Date(Date.now() - 15 * 60000).toISOString()).all<{ id: string }>()).results
  for (const entry of abandoned) await env.TICKETS.delete(`files/${entry.id}`).catch(() => {})
  const rows = (await env.DB.prepare('SELECT key,storage_key,etag,metadata FROM file_objects WHERE copied=0 ORDER BY key LIMIT 3').all<{ key: string; storage_key: string; etag: string; metadata: string }>()).results
  for (const row of rows) {
    const bytes = await env.TICKETS.get(row.storage_key, 'arrayBuffer')
    if (!bytes) fail(503, 'file_propagating', 'A source file is temporarily unavailable. Retry migration shortly.')
    const metadata = JSON.parse(row.metadata)
    await env.FILES.put(row.key, bytes, metadata)
    const copied = await env.FILES.get(row.key)
    if (!copied || copied.size > 20 * 1024 * 1024) fail(502, 'copy_failed', 'The copied file could not be verified')
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await copied.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (digest !== row.etag) fail(502, 'copy_mismatch', 'The copied file did not match its source. Retry migration.')
    await env.DB.prepare('UPDATE file_objects SET copied=1 WHERE key=? AND storage_key=?').bind(row.key, row.storage_key).run()
  }
  const pending = await env.DB.prepare('SELECT COUNT(*) as count FROM file_objects WHERE copied=0').first<{ count: number }>()
  const uploading = await env.DB.prepare('SELECT COUNT(*) as count FROM file_uploads').first<{ count: number }>()
  const done = !pending?.count && !uploading?.count
  if (done) await env.DB.batch([
    env.DB.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES('storage.backend','r2',?) ON CONFLICT(key) DO UPDATE SET value='r2',updated_at=excluded.updated_at").bind(new Date().toISOString()),
    env.DB.prepare("DELETE FROM server_settings WHERE key='storage.migration'"),
  ])
  return { done, remaining: pending?.count ?? 0 }
})
