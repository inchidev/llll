import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outputDir = join(root, '.installer', 'release')
const bundlePath = join(root, '.installer', 'bundle', 'index.js')
const assetsDir = join(root, '.output', 'public')
const migrationsDir = join(root, 'drizzle', 'server-migrations')

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = (process.env.LLLL_RELEASE_VERSION || packageJson.version).replace(/^v/, '')
const releaseBaseUrl = process.env.LLLL_RELEASE_BASE_URL
  || `https://github.com/inchidev/llll/releases/download/v${version}`

const contentTypes = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex')
}

async function filesUnder(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(path))
    else if (entry.isFile()) result.push(path)
  }
  return result.sort()
}

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

const worker = await readFile(bundlePath)
const workerName = 'llll-worker.mjs'
await writeFile(join(outputDir, workerName), worker)

const assets = []
for (const file of await filesUnder(assetsDir)) {
  const content = await readFile(file)
  assets.push({
    path: `/${relative(assetsDir, file).split(sep).join('/')}`,
    hash: digest('md5', content),
    size: content.byteLength,
    contentType: contentTypes[extname(file).toLowerCase()] || 'application/octet-stream',
    contentBase64: content.toString('base64'),
  })
}

const migrations = []
for (const file of (await filesUnder(migrationsDir)).filter(path => path.endsWith('.sql'))) {
  migrations.push({
    name: basename(file),
    sql: await readFile(file, 'utf8'),
  })
}

const assetsName = 'llll-assets.json'
const assetsPayload = Buffer.from(JSON.stringify({ assets, migrations }))
await writeFile(join(outputDir, assetsName), assetsPayload)

const manifest = {
  schemaVersion: 1,
  version,
  releasedAt: new Date().toISOString(),
  compatibilityDate: '2026-09-28',
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  capabilities: ['cloudflare-access-auth', 'optional-r2', 'basic-kv-storage-v1', 'server-mail-v1', 'llll-server-schema-v1'],
  worker: {
    url: `${releaseBaseUrl}/${workerName}`,
    sha256: digest('sha256', worker),
    size: worker.byteLength,
  },
  assets: {
    url: `${releaseBaseUrl}/${assetsName}`,
    sha256: digest('sha256', assetsPayload),
    size: assetsPayload.byteLength,
  },
  removedBindings: ['AGENT_THINK'],
  durableObjectMigrations: [
    { tag: 'v1', new_sqlite_classes: ['ChannelDurableObject', 'ServerDurableObject', 'RateLimitDurableObject', 'NotificationDurableObject', 'L4Agent', 'L4Think'] },
    { tag: 'v2-agent-runs', new_sqlite_classes: ['AgentRunDurableObject'] },
    { tag: 'v3-agent-schedules', new_sqlite_classes: ['AgentScheduleDurableObject'] },
    { tag: 'v4-retire-think', deleted_classes: ['L4Think'] },
  ],
  durableObjects: [
    { binding: 'CHANNEL_DO', className: 'ChannelDurableObject', migration: 'v1' },
    { binding: 'SERVER_DO', className: 'ServerDurableObject', migration: 'v1' },
    { binding: 'RATE_LIMIT_DO', className: 'RateLimitDurableObject', migration: 'v1' },
    { binding: 'NOTIFICATION_DO', className: 'NotificationDurableObject', migration: 'v1' },
    { binding: 'AGENT_DO', className: 'L4Agent', migration: 'v1' },
    { binding: 'AGENT_RUN_DO', className: 'AgentRunDurableObject', migration: 'v2-agent-runs' },
    { binding: 'AGENT_SCHEDULE_DO', className: 'AgentScheduleDurableObject', migration: 'v3-agent-schedules' },
  ],

}

await writeFile(join(outputDir, 'llll-cloudflare-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const outputSize = (await stat(join(outputDir, assetsName))).size
console.log(`Built L4 installer release ${version}: ${assets.length} assets, ${migrations.length} migrations, ${outputSize} byte asset payload.`)
