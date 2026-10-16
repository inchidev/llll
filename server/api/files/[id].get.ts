import { eq } from 'drizzle-orm'
import { attachments } from '../../../drizzle/schema'
import { parseByteRange } from '../../../shared/http-range'
import { requireChannelMember } from '../../utils/guards'
import { cf, requireFiles, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(attachments).where(eq(attachments.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'File not found')
  await requireChannelMember(event, row.channelId)

  const rangeHeader = getHeader(event, 'range')
  let obj: R2ObjectBody | null
  if (rangeHeader) {
    const metadata = await requireFiles(env).head(row.r2Key)
    if (!metadata) fail(404, 'not_found', 'Blob missing')
    const range = parseByteRange(rangeHeader, metadata.size)
    if (!range) {
      setHeader(event, 'Content-Range', `bytes */${metadata.size}`)
      fail(416, 'range_not_satisfiable', 'Requested file range is not satisfiable')
    }
    obj = await requireFiles(env).get(row.r2Key, { range: { offset: range.offset, length: range.length } })
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`)
    setHeader(event, 'Content-Length', range.length)
  }
  else {
    obj = await requireFiles(env).get(row.r2Key)
    if (obj) setHeader(event, 'Content-Length', obj.size)
  }
  if (!obj) fail(404, 'not_found', 'Blob missing')
  setHeader(event, 'Content-Type', row.contentType)
  setHeader(event, 'Content-Disposition', `inline; filename="${row.filename.replaceAll('"', '')}"`)
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'ETag', obj.httpEtag)
  return obj.body
})
