import { giteaConnectSchema } from '../../../shared/git-connections'
import { getServerId } from '../../../shared/server-id'
import { connectGitea } from '../../utils/gitea'
import { requireMember } from '../../utils/guards'
import { cf, fail, originOk } from '../../utils/cf'
import { parseBody } from '../../utils/validate'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  if (!await originOk(event)) fail(403, 'origin_denied', 'Connect Gitea from this Server')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return { connection: await connectGitea(env, actor.authorization, parseBody(giteaConnectSchema, await readBody(event))) }
})
