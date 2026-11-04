import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getDocument } from '../../../utils/document-service'
import { documentMarkdown } from '../../../utils/document-content'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.readData)
  const document = await getDocument(env, actor.authorization, getRouterParam(event, 'id')!)
  setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="document.md"; filename*=UTF-8''${encodeURIComponent(document.title + '.md')}`)
  return documentMarkdown(document.content) + '\n'
})
