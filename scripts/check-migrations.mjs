import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const migrationsDirectory = join(root, 'drizzle/server-migrations')
const bootstrapPath = join(root, 'server/utils/db.ts')
const migrationPattern = /^(?<number>[0-9]{4})_(?<slug>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u

export function validateMigrationFileNames(fileNames) {
  const migrations = fileNames.map((fileName) => {
    const match = basename(fileName).match(migrationPattern)
    if (!match?.groups) {
      throw new Error(`Migration ${fileName} must match NNNN_lowercase_name.sql`)
    }
    return {
      fileName: basename(fileName),
      number: Number.parseInt(match.groups.number, 10),
    }
  }).sort((left, right) => left.number - right.number || left.fileName.localeCompare(right.fileName))

  const byNumber = new Map()
  for (const migration of migrations) {
    const duplicate = byNumber.get(migration.number)
    if (duplicate) {
      const number = String(migration.number).padStart(4, '0')
      throw new Error(`Duplicate migration number ${number}: ${duplicate} and ${migration.fileName}`)
    }
    byNumber.set(migration.number, migration.fileName)
  }

  migrations.forEach((migration, index) => {
    if (migration.number !== index) {
      const expected = String(index).padStart(4, '0')
      throw new Error(`Migration sequence must be contiguous; expected ${expected}, found ${migration.fileName}`)
    }
  })

  return migrations
}

export function validateBootstrapRegistry(source, migrations) {
  const imports = [...source.matchAll(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+'\.\.\/\.\.\/drizzle\/server-migrations\/([^']+\.sql)\?raw'$/gmu,
  )].map(match => ({ identifier: match[1], fileName: match[2] }))
  const expectedFiles = migrations.map(migration => migration.fileName)
  const importedFiles = imports.map(migration => migration.fileName)

  if (JSON.stringify(importedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('server/utils/db.ts migration imports must exactly match the ordered migration directory')
  }

  const registry = source.match(
    /export const INIT_SQL = d1ExecSql\(\[\n(?<body>[\s\S]*?)\n\]\.join\('\\n--> statement-breakpoint\\n'\)\)/u,
  )
  if (!registry?.groups?.body) throw new Error('Could not find the INIT_SQL migration registry in server/utils/db.ts')

  const identifiers = [...registry.groups.body.matchAll(/^\s*([A-Za-z_$][\w$]*),\s*$/gmu)]
    .map(match => match[1])
  const importedIdentifiers = imports.map(migration => migration.identifier)
  if (JSON.stringify(identifiers) !== JSON.stringify(importedIdentifiers)) {
    throw new Error('INIT_SQL must include every imported migration exactly once and in order')
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function migrationFilesAt(revision, directory) {
  return git(['ls-tree', '-r', '--name-only', revision, '--', directory])
    .split('\n').filter(path => path.endsWith('.sql')).map(path => basename(path))
}

/** The schema marker a baseline seeds, e.g. server-v2; null for chains without one. */
export function schemaLineage(baselineSql) {
  return /INSERT INTO `?server_schema`?[^;]*'(server-v\d+)'/u.exec(baselineSql)?.[1] ?? null
}

function verifyImmutableHistory(baseRevision, currentMigrations, directory) {
  execFileSync('git', ['merge-base', '--is-ancestor', baseRevision, 'HEAD'], { cwd: root, stdio: 'ignore' })
  const previous = validateMigrationFileNames(migrationFilesAt(baseRevision, directory))
  // A new lineage replaces the previous chain with a fresh baseline; only its own files are immutable.
  if (previous.length && currentMigrations.length) {
    const before = schemaLineage(execFileSync('git', ['show', `${baseRevision}:${directory}/${previous[0].fileName}`], { cwd: root, encoding: 'utf8' }))
    const after = schemaLineage(readFileSync(join(root, directory, currentMigrations[0].fileName), 'utf8'))
    if (before && after && before !== after) return
  }
  for (const migration of previous) {
    const before = execFileSync('git', ['show', `${baseRevision}:${directory}/${migration.fileName}`], { cwd: root })
    const after = readFileSync(join(root, directory, migration.fileName))
    if (!before.equals(after)) throw new Error(`Merged migration SQL is immutable: ${directory}/${migration.fileName}`)
  }
  const previousNames = new Set(previous.map(migration => migration.fileName))
  currentMigrations.filter(migration => !previousNames.has(migration.fileName)).forEach((migration, index) => {
    if (migration.number !== previous.length + index) throw new Error('New migrations must append to the current schema lineage')
  })
}

function baseRevisionFromArguments(arguments_) {
  const index = arguments_.indexOf('--base')
  if (index >= 0) return arguments_[index + 1]
  const inline = arguments_.find(argument => argument.startsWith('--base='))
  return inline?.slice('--base='.length) || process.env.MIGRATION_BASE_SHA || ''
}

export async function checkMigrations({ baseRevision = '' } = {}) {
  const fileNames = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
  const migrations = validateMigrationFileNames(fileNames)
  validateBootstrapRegistry(await readFile(bootstrapPath, 'utf8'), migrations)

  const webFiles = (await readdir(join(root, 'apps/site/migrations'))).filter(name => name.endsWith('.sql'))
  const web = validateMigrationFileNames(webFiles)
  if (baseRevision) {
    verifyImmutableHistory(baseRevision, web, 'apps/site/migrations')
    verifyImmutableHistory(baseRevision, migrations, 'drizzle/server-migrations')
  }
  console.log(`Validated ${web.length} web migrations`)

  const first = migrations.at(0)?.fileName.slice(0, 4) || 'none'
  const last = migrations.at(-1)?.fileName.slice(0, 4) || 'none'
  console.log(`Validated ${migrations.length} sequential migrations (${first}-${last})`)
  if (baseRevision) console.log(`Verified immutable migration history against ${baseRevision}`)
  return migrations
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkMigrations({ baseRevision: baseRevisionFromArguments(process.argv.slice(2)) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
