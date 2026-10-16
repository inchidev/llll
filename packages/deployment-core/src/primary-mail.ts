import type Cloudflare from 'cloudflare'
import { createError } from './errors.js'
import type { DeployRequest } from './types.js'

export type PrimaryMailProvision = {
  name: string
  token?: string
  primary: true
}

/** The first managed workspace on a zone owns that zone's mail bindings. */
export async function ensurePrimaryMail(
  client: Cloudflare,
  _accessToken: string,
  request: DeployRequest,
): Promise<PrimaryMailProvision> {
  for await (const worker of client.workers.scripts.list({ account_id: request.accountId })) {
    if (!worker.id || worker.id === request.workerName) continue
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(worker.id, { account_id: request.accountId })
    const bindings = settings.bindings as Array<{ name?: string, type?: string, text?: string }> || []
    const managed = bindings.some(binding => binding.name === 'LLLL_INSTALLATION' && binding.type === 'plain_text')
    const sameZone = bindings.some(binding => binding.name === 'MAIL_ZONE_ID' && binding.text === request.zoneId)
    if (managed && sameZone) {
      throw createError({
        statusCode: 409,
        statusMessage: `Mail for ${request.zoneName} already belongs to primary L4 Worker ${worker.id}`,
      })
    }
  }
  return { name: request.workerName, primary: true }
}

export async function removePrimaryMail(
  _client: Cloudflare,
  _accessToken: string,
  _accountId: string,
  _zoneId: string,
  _zoneName: string,
  workerName: string,
  _domain: string,
) {
  return { gatewayName: workerName, lastRoute: true, removed: true }
}
