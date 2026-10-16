import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const configPath = resolve(root, 'apps/site/wrangler.jsonc')

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  if (result.stdout?.trim()) process.stdout.write(result.stdout)
  if (result.stderr?.trim()) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.join(' ')} failed`)
  return result
}

function listJson(args) {
  const result = wrangler([...args, '--json'])
  return JSON.parse(result.stdout)
}

async function ensureDatabase(name) {
  wrangler(['d1', 'create', name], { allowFailure: true })
  const database = listJson(['d1', 'list']).find(candidate => candidate.name === name)
  const id = database?.uuid || database?.id
  if (!id) throw new Error(`D1 database ${name} was not returned after creation`)
  return id
}

/** Staging only: safe on PR branches, never touches the production DB. */
export async function migrateStaging() {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.previews.d1_databases[0].database_id = await ensureDatabase('llll-portal-staging')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const stagingConfig = {
    $schema: '../../node_modules/wrangler/config-schema.json',
    name: 'llll-staging-migrations',
    compatibility_date: config.compatibility_date,
    d1_databases: [{ binding: 'PORTAL_DB', database_name: 'llll-portal-staging', database_id: config.previews.d1_databases[0].database_id, migrations_dir: 'migrations' }],
  }
  await writeFile(resolve(root, 'apps/site/.wrangler.preview-migrations.generated.jsonc'), `${JSON.stringify(stagingConfig, null, 2)}\n`)
  wrangler(['d1', 'migrations', 'apply', 'PORTAL_DB', '--remote', '-c', 'apps/site/.wrangler.preview-migrations.generated.jsonc'])
}

/** Production + staging. Runs on push to main only. */
export async function migrate() {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.d1_databases[0].database_id = await ensureDatabase('llll-portal')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  wrangler(['d1', 'migrations', 'apply', 'PORTAL_DB', '--remote', '-c', 'apps/site/wrangler.jsonc'])
  await migrateStaging()
}

export async function deploy() {
  await migrate()
  wrangler(['deploy', '-c', 'apps/site/wrangler.jsonc'])
}

export async function preview(name) {
  const value = String(name || process.env.PREVIEW_NAME || '').trim()
  if (!/^pr-[1-9][0-9]{0,9}$/.test(value)) throw new Error('Preview name must look like pr-4')
  const result = wrangler(['preview', '--config', 'apps/site/wrangler.jsonc', '--worker-name', 'llll', '--name', value, '--json'])
  const match = result.stdout.match(/\{[\s\S]*\}/)
  const parsed = match ? JSON.parse(match[0]) : {}
  console.log(JSON.stringify({ name: value, url: parsed.url || parsed.preview_url || '' }))
}

export async function previewDelete(name) {
  const value = String(name || '').trim()
  if (!/^pr-[1-9][0-9]{0,9}$/.test(value)) throw new Error('Preview name must look like pr-4')
  wrangler(['preview', 'delete', '--config', 'apps/site/wrangler.jsonc', '--worker-name', 'llll', '--name', value, '--skip-confirmation'])
}

async function main() {
  const [command, argument] = process.argv.slice(2)
  if (command === 'migrate') return migrate()
  if (command === 'migrate-staging') return migrateStaging()
  if (command === 'deploy') return deploy()
  if (command === 'preview') return preview(argument)
  if (command === 'preview-delete') return previewDelete(argument)
  throw new Error('Usage: site-cloudflare.mjs <migrate|migrate-staging|deploy|preview pr-N|preview-delete pr-N>')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
