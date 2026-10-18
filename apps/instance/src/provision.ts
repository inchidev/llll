import { installBaseL4, cloudflareApi, updateL4 } from '../../../packages/deployment-core/src/index'
import type { InstanceEnv } from './env'

export type ServerRow = { public_id: string; id: string; name: string; owner_id: string; origin: string; worker_name: string | null; secret: string; version: string; status: 'provisioning' | 'ready' | 'failed'; error: string | null }

export async function provisionServer(env: InstanceEnv, server: ServerRow, owner: { email: string }, secret: string) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !server.worker_name) throw new Error('Configure Cloudflare provisioning or use the self-host deployment command')
  const token = env.CLOUDFLARE_API_TOKEN
  // The browser verifies the public endpoint before admitting the new Server.
  const result = await installBaseL4(token, {
    accountId: env.CLOUDFLARE_ACCOUNT_ID, workerName: server.worker_name, appName: server.name,
    adminEmail: owner.email, allowedEmails: [], authMode: 'builtin', registrationMode: 'invite_only', filesEnabled: true, backupBucketName: env.BACKUP_BUCKET_NAME || `${server.worker_name}-backups`,
  }, { manifestUrl: env.RELEASE_MANIFEST, verify: false })
  for (const [name, text] of Object.entries({ LLLL_INSTALLATION_ORIGIN: env.PUBLIC_ORIGIN, LLLL_SERVER_ID: server.id, LLLL_SERVER_OWNER_ID: server.owner_id, LLLL_INSTALLATION_KEY: secret })) {
    await cloudflareApi(token, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${server.worker_name}/secrets`, { method: 'PUT', body: JSON.stringify({ name, text, type: 'secret_text' }) })
  }
  return result
}

export async function updateServer(env: InstanceEnv, server: ServerRow, version: string) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !server.worker_name) throw new Error('This server is updated by its self-host operator')
  // The provisioning manifest can be pinned; updates resolve their selected immutable release.
  // The browser confirms public reachability, as it does for a new Server.
  return updateL4(env.CLOUDFLARE_API_TOKEN, { accountId: env.CLOUDFLARE_ACCOUNT_ID, workerName: server.worker_name, targetVersion: version }, { verify: false })
}
