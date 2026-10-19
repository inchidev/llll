import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireWorkersBuild } from './ci-only.mjs'
requireWorkersBuild()
const root = resolve(import.meta.dirname, '..')
const dir = resolve(root, '.deployment/builds')
await mkdir(dir, { recursive: true })
const file = resolve(dir, 'deployment-core.mjs')
await build({
  entryPoints: [resolve(root, 'packages/deployment-core/src/index.ts')],
  outfile: file,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
})
const { installL4, verifyDeployment } = await import(pathToFileURL(file).href)
const workerName = process.env.LLLL_SERVER_WORKER
const targetVersion = process.env.LLLL_SERVER_RELEASE
if (
  !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName || '') ||
  !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(targetVersion || '')
)
  throw new Error('Configure a Worker name and immutable release version')
const claim = process.env.LLLL_SERVER_SETUP_TOKEN
if (!claim || claim.length < 32) throw new Error('Configure a private owner claim of at least 32 characters')
async function setOwnerClaim() {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${workerName}/secrets`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'SETUP_TOKEN', type: 'secret_text', text: claim }),
    },
  )
  const result = await response.json()
  if (!response.ok || !result.success) throw new Error('Cannot configure the private owner claim')
}
const origin = process.env.LLLL_SERVER_ORIGIN
if (origin) {
  const response = await fetch(origin + '/.well-known/llll').catch(() => null)
  const data = response?.ok ? await response.json() : null
  if (data?.kind === 'server' && data.version === targetVersion.slice(1)) {
    if (!data.ready) await setOwnerClaim()
    console.log('Selected release already deployed; Server unchanged')
    process.exit(0)
  }
}
const zoneId = process.env.LLLL_SERVER_ZONE_ID || ''
const zoneName = process.env.LLLL_SERVER_ZONE_NAME || ''
const subdomain = process.env.LLLL_SERVER_SUBDOMAIN || workerName
const result = await installL4(process.env.CLOUDFLARE_API_TOKEN, {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  workerName,
  targetVersion,
  appName: process.env.LLLL_SERVER_NAME || 'L4',
  adminEmail: process.env.LLLL_SERVER_OWNER_EMAIL,
  allowedEmails: [],
  authMode: 'builtin',
  registrationMode: 'invite_only',
  filesEnabled: true,
  backupBucketName: process.env.LLLL_SERVER_BACKUP_BUCKET || workerName + '-backups',
  customDomainEnabled: Boolean(zoneId),
  zoneId,
  zoneName,
  appSubdomain: subdomain,
  mailEnabled: false,
  mailSubdomain: '',
  mailLocalPart: '',
}, { verify: false })
// Persist the browser-bound claim before public DNS/TLS verification. A failed
// first verification must never lose the only usable owner claim on retry.
await setOwnerClaim()
await verifyDeployment(result.url, result.version, false, undefined, { attempts: 150 })
result.verified = true
await writeFile(
  resolve(dir, 'server-result.json'),
  JSON.stringify({ ...result, setupUrl: undefined }),
  { mode: 0o600 },
)
console.log(`Server release ${result.version} verified at ${result.url}`)
