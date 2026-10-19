import { readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateMigrationFileNames } from './check-migrations.mjs'

const root = resolve(import.meta.dirname, '..')
const target = process.argv[3] || 'server'
const directories = { server: 'drizzle/server-migrations', web: 'apps/site/migrations' }
if (!Object.hasOwn(directories, target)) throw new Error('Choose server or web')
const migrationsDirectory = join(root, directories[target])
const slug = process.argv[2]?.trim() || ''

if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(slug)) {
  throw new Error('Usage: pnpm db:migration:create lowercase_migration_name')
}

const fileNames = (await readdir(migrationsDirectory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
  .map(entry => entry.name)
const migrations = validateMigrationFileNames(fileNames)
const number = String(migrations.length).padStart(4, '0')
const fileName = `${number}_${slug}.sql`
const filePath = join(migrationsDirectory, fileName)

await writeFile(filePath, `-- ${slug.replaceAll('_', ' ')}\n`)
console.log(filePath)
