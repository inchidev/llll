import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// One shared staging for all server-worker Previews (DO namespaces are
// automatic per Preview; D1/R2/KV are isolated by binding to staging
// resources here instead of production ones).
// Run once per account: pnpm staging:setup

const root = resolve(import.meta.dirname, '..')
const configPath = resolve(root, 'wrangler.jsonc')

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  if (result.stdout?.trim()) process.stdout.write(result.stdout)
  if (result.stderr?.trim()) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.join(' ')} failed`)
  return result
}

function listJson(args, { noJsonFlag = false } = {}) {
  return JSON.parse(wrangler(noJsonFlag ? args : [...args, '--json'], { allowFailure: true }).stdout || '[]')
}

async function setup() {
  wrangler(['d1', 'create', 'llll-staging'], { allowFailure: true })
  const database = listJson(['d1', 'list']).find(candidate => candidate.name === 'llll-staging')
  const databaseId = database?.uuid || database?.id
  if (!databaseId) throw new Error('D1 database llll-staging was not returned after creation')

  wrangler(['r2', 'bucket', 'create', 'llll-staging-files'], { allowFailure: true })

  let kvId = listJson(['kv', 'namespace', 'list'], { noJsonFlag: true }).find(candidate => candidate.title === 'llll-staging-tickets')?.id
  if (!kvId) {
    const created = wrangler(['kv', 'namespace', 'create', 'llll-staging-tickets'])
    kvId = created.stdout.match(/["']id["']\s*:\s*"([^"]+)"/)?.[1]
  }
  if (!kvId) throw new Error('KV namespace llll-staging-tickets was not returned after creation')

  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.previews.d1_databases[0].database_id = databaseId
  config.previews.kv_namespaces[0].id = kvId
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const stagingConfig = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: `${config.name}-staging-migrations`,
    compatibility_date: config.compatibility_date,
    d1_databases: [{ binding: 'DB', database_name: 'llll-staging', database_id: databaseId, migrations_dir: 'drizzle/migrations' }],
  }
  const stagingPath = resolve(root, '.wrangler.preview-migrations.generated.jsonc')
  await writeFile(stagingPath, `${JSON.stringify(stagingConfig, null, 2)}\n`)
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '-c', '.wrangler.preview-migrations.generated.jsonc'])
  console.log(JSON.stringify({ database: 'llll-staging', bucket: 'llll-staging-files', kv: kvId }))
}

async function main() {
  const [command] = process.argv.slice(2)
  if (command === 'setup') return setup()
  throw new Error('Usage: preview-staging.mjs setup')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
