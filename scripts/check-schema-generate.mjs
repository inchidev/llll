import { spawnSync } from 'node:child_process'
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// `drizzle/schema.ts` must have nothing to generate: every change to it is in a migration.
const root = resolve(import.meta.dirname, '..')
// Inside the checkout: drizzle-kit reads its snapshots relative to it, and exits 0 when it can't.
const out = '.schema-check'
const config = join(root, '.schema-check.config.ts')
try {
  cpSync(join(root, 'drizzle/server-migrations/meta'), join(root, out, 'meta'), { recursive: true })
  writeFileSync(config, `import { defineConfig } from 'drizzle-kit'\nexport default defineConfig({ schema: './drizzle/schema.ts', out: ${JSON.stringify(`./${out}`)}, dialect: 'sqlite' })\n`)
  const run = spawnSync('pnpm', ['exec', 'drizzle-kit', 'generate', '--config', config], { cwd: root, encoding: 'utf8' })
  // Only its own words prove it compared anything.
  if (!run.stdout.includes('No schema changes')) {
    console.error(run.stdout + run.stderr)
    throw new Error('drizzle/schema.ts has changes without a migration. Run: pnpm db:generate')
  }
  console.log('Schema matches its migrations')
}
finally {
  rmSync(config, { force: true })
  rmSync(join(root, out), { recursive: true, force: true })
}
