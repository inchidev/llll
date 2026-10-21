import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { mcpAuthFromEvent } from '../../../../utils/better-auth'

export default defineEventHandler(async (event) => {
  const auth = await mcpAuthFromEvent(event)
  return oauthProviderAuthServerMetadata(auth)(toWebRequest(event))
})
