import { readdirSync, readFileSync } from 'node:fs'

/** The official site's schema: every web migration, in order. */
export function webMigrationsSql() {
  const directory = 'apps/site/migrations'
  return readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(`${directory}/${name}`, 'utf8')).join('\n')
}
