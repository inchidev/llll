// Generate an operator-owned Compose installation. Secrets never enter Git.
import { mkdir, writeFile, access } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const destination = resolve(process.argv[2] || '.deployment/self-host')
const origin = new URL(process.argv[3] || 'http://localhost:8080').origin
const ids = process.argv.slice(4).length ? process.argv.slice(4) : ['main']
if (ids.some(id => !/^[a-z][a-z0-9-]{0,39}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Use unique lowercase server IDs (up to 40 characters)')
await mkdir(destination, { recursive: true })
try { await access(resolve(destination, 'compose.json')); throw new Error('Destination already contains a deployment. Choose a new directory; keep existing secrets for updates.') }
catch (error) { if (error.code !== 'ENOENT') throw error }
const random = () => randomBytes(32).toString('hex')
const credentials = { RUSTFS_ACCESS_KEY: 'l4' + random().slice(0, 20), RUSTFS_SECRET_KEY: random() }
const setup = random()
const registry = []
const services = {
  'rustfs-perms': { image: 'alpine:3.22', user: '0:0', volumes: ['rustfs-data:/data'], command: ['sh', '-c', 'chown -R 10001:10001 /data'] },
  rustfs: { image: 'rustfs/rustfs:1.0.1', restart: 'unless-stopped', depends_on: { 'rustfs-perms': { condition: 'service_completed_successfully' } }, environment: { RUSTFS_VOLUMES: '/data', RUSTFS_ADDRESS: '0.0.0.0:9000', RUSTFS_CONSOLE_ENABLE: 'false', ...credentials }, volumes: ['rustfs-data:/data'], healthcheck: { test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:9000/health'], interval: '10s', timeout: '5s', retries: 12 } },
}
const volumes = { 'rustfs-data': {} }
function runtime(name, env) {
  volumes[`${name}-data`] = {}
  return { build: { context: relative(destination, root), dockerfile: 'self-host/Dockerfile' }, image: 'llll:local', restart: 'unless-stopped', depends_on: { 'bucket-init': { condition: 'service_completed_successfully' } }, environment: { ADMIN_EMAIL: 'owner@example.com', ADMIN_SETUP_TOKEN: setup, AUTH_SECRET: random(), ...env, AWS_ACCESS_KEY_ID: credentials.RUSTFS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: credentials.RUSTFS_SECRET_KEY, AWS_REGION: 'us-east-1', S3_ENDPOINT: 'http://rustfs:9000', CELLD_BUCKET: `s3://${name}-cells`, CELLD_WATCH: '/var/lib/llll/celld', CELLD_DURABILITY: 'bucket', CELLD_READY_FLEET_GATE_MS: '0' }, volumes: [`${name}-data:/var/lib/llll/celld`] }
}
services.installation = runtime('installation', { LLLL_MODE: 'installation', PUBLIC_ORIGIN: origin, INSTALLATION_ID: 'self-host', INSTALLATION_NAME: 'My L4', SETUP_TOKEN: setup, CLIENT_ORIGINS: 'https://app.llll.gg', TRUSTED_SERVER_ORIGINS: ids.map(id => `http://l4-${id}:8080`).join(',') })
services.installation.ports = [`127.0.0.1:${new URL(origin).hostname === 'localhost' ? (new URL(origin).port || 8080) : 8080}:8080`]
for (const id of ids) {
  const key = random()
  const serverOrigin = `http://l4-${id}:8080`
  services[`l4-${id}`] = runtime(`l4-${id}`, { PUBLIC_ORIGIN: serverOrigin, ADMIN_WORKSPACE: id, APP_NAME: id, LLLL_SERVER_ID: id, LLLL_INSTALLATION_ORIGIN: origin, LLLL_INSTALLATION_INTERNAL_ORIGIN: 'http://installation:8080', LLLL_INSTALLATION_KEY: key, LLLL_ALLOW_INSTALLATION_BOOTSTRAP: 'true' })
  registry.push({ id, name: id, origin: serverOrigin, key })
}
services['bucket-init'] = { image: 'amazon/aws-cli:2.38.0', depends_on: { rustfs: { condition: 'service_healthy' } }, environment: { AWS_ACCESS_KEY_ID: credentials.RUSTFS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: credentials.RUSTFS_SECRET_KEY, AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true' }, entrypoint: ['/bin/sh', '-c'], command: ['aws configure set default.s3.addressing_style path\n' + Object.keys(services).filter(name => name === 'installation' || name.startsWith('l4-')).map(name => `aws s3api head-bucket --bucket ${name}-cells --endpoint-url http://rustfs:9000 >/dev/null 2>&1 || aws s3api create-bucket --bucket ${name}-cells --endpoint-url http://rustfs:9000`).join('\n')] }
await writeFile(resolve(destination, 'compose.json'), JSON.stringify({ name: 'llll-installation', services, volumes }, null, 2) + '\n', { mode: 0o600 })
await writeFile(resolve(destination, 'servers.json'), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 })
await writeFile(resolve(destination, 'owner-claim.txt'), `${origin}/connections#claim=${setup}\n`, { mode: 0o600 })
console.log(`Created ${destination}. Run docker compose -f ${destination}/compose.json up -d --build. Open owner-claim.txt privately, then register the entries in servers.json using Installation settings. Put TLS in front before connecting app.llll.gg.`)
