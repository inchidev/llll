import { eq } from 'drizzle-orm'
import { taskAttachments } from '../../../drizzle/schema'
import { parseByteRange } from '../../../shared/http-range'
import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, requireFiles, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event) => {
  await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const row = (await getDb(env.DB).select().from(taskAttachments).where(eq(taskAttachments.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'File not found')
  const rangeHeader = getHeader(event, 'range')
  let object: R2ObjectBody | null
  if (rangeHeader) {
    const metadata = await requireFiles(env).head(row.r2Key)
    if (!metadata) fail(404, 'not_found', 'Blob missing')
    const range = parseByteRange(rangeHeader, metadata.size)
    if (!range) {
      setHeader(event, 'Content-Range', `bytes */${metadata.size}`)
      fail(416, 'range_not_satisfiable', 'Requested file range is not satisfiable')
    }
    object = await requireFiles(env).get(row.r2Key, { range: { offset: range.offset, length: range.length } })
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`)
    setHeader(event, 'Content-Length', range.length)
  }
  else {
    object = await requireFiles(env).get(row.r2Key)
    if (object) setHeader(event, 'Content-Length', object.size)
  }
  if (!object) fail(404, 'not_found', 'Blob missing')
  setHeader(event, 'Content-Type', row.contentType)
  setHeader(event, 'Content-Disposition', `inline; filename="${row.filename.replaceAll('"', '')}"`)
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'ETag', object.httpEtag)
  return object.body
})
