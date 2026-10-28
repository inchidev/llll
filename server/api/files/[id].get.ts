import { eq } from 'drizzle-orm'
import { attachments, messages } from '../../../drizzle/schema'
import { fileResponseHeaders } from '../../../shared/file-response'
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
  const access = await requireChannelMember(event, row.channelId)
  // An upload not yet sent (or on a draft) belongs to its uploader alone.
  if (!row.messageId && row.uploaderId !== access.user.id) fail(404, 'not_found', 'File not found')
  if (row.messageId) {
    const parent = (await db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, row.messageId)).limit(1))[0]
    if (!parent || parent.deletedAt) fail(404, 'not_found', 'File not found')
  }

  const rangeHeader = getHeader(event, 'range')
  let obj: import('../../../shared/file-storage').FileBody | null
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
  for (const [name, value] of Object.entries(fileResponseHeaders(row.contentType, row.filename))) setHeader(event, name, value)
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'ETag', obj.httpEtag)
  return obj.body
})
