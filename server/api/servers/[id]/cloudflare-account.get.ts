import { cloudflareAccessStatus } from '../../../utils/cloudflare-account-access'
import { serverDeployment, updateOwner } from '../../../utils/server-updates'

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = await updateOwner(event)
  const deployment = await serverDeployment(env)
  return { available: Boolean(deployment), accountId: deployment?.accountId ?? null, access: await cloudflareAccessStatus(env) }
})
