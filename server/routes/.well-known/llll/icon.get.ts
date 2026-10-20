import { getServerId } from '../../../../shared/server-id'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { ensureMigrated } from '../../../utils/db'

/** Public branding only: no caller-controlled bucket key or private file access. */
export default defineEventHandler(async event => {
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  setHeader(event, 'Cache-Control', 'no-cache')
  setHeader(event, 'Access-Control-Allow-Origin', '*')
  const row = await env.DB.prepare('SELECT icon_r2_key AS iconR2Key, updated_at AS updatedAt FROM server WHERE id = ?').bind(await getServerId(env.DB))
    .first<{ iconR2Key: string | null; updatedAt: string }>()
  if (!row?.iconR2Key) fail(404, 'not_found', 'Server icon not found')
  const object = await requireFiles(env).get(row.iconR2Key)
  if (!object) fail(404, 'not_found', 'Server icon not found')
  const mime = object.httpMetadata?.contentType
  if (!mime || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) fail(404, 'not_found', 'Server icon not found')
  setHeader(event, 'Content-Type', mime)
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'ETag', object.httpEtag)
  if (getHeader(event, 'if-none-match') === object.httpEtag) { setResponseStatus(event, 304); return null }
  return object.body
})
