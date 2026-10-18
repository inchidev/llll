import { describe, expect, it } from 'vitest'
import { validateBootstrapRegistry, validateMigrationFileNames, validateWebBaselineRename } from '../../scripts/check-migrations.mjs'

describe('migration policy', () => {
  it('accepts one contiguous migration for every number', () => {
    expect(validateMigrationFileNames([
      '0002_add_messages.sql',
      '0000_init.sql',
      '0001_add_channels.sql',
    ])).toEqual([
      { fileName: '0000_init.sql', number: 0 },
      { fileName: '0001_add_channels.sql', number: 1 },
      { fileName: '0002_add_messages.sql', number: 2 },
    ])
  })

  it('rejects two agents claiming the same number', () => {
    expect(() => validateMigrationFileNames([
      '0000_init.sql',
      '0001_add_channels.sql',
      '0001_add_messages.sql',
    ])).toThrow('Duplicate migration number 0001')
  })

  it('rejects gaps and names that do not follow the shared convention', () => {
    expect(() => validateMigrationFileNames([
      '0000_init.sql',
      '0002_add_messages.sql',
    ])).toThrow('expected 0001')
    expect(() => validateMigrationFileNames([
      '0000_Init.sql',
    ])).toThrow('must match NNNN_lowercase_name.sql')
  })

  it('requires the bootstrap registry to contain every migration in order', () => {
    const migrations = validateMigrationFileNames([
      '0000_init.sql',
      '0001_add_channels.sql',
    ])
    const valid = `import initSql from '../../drizzle/migrations/0000_init.sql?raw'
import channelsSql from '../../drizzle/migrations/0001_add_channels.sql?raw'

export const INIT_SQL = d1ExecSql([
  initSql,
  channelsSql,
].join('\\n--> statement-breakpoint\\n'))`

    expect(() => validateBootstrapRegistry(valid, migrations)).not.toThrow()
    expect(() => validateBootstrapRegistry(valid.replace('  channelsSql,\n', ''), migrations))
      .toThrow('INIT_SQL must include every imported migration exactly once and in order')
  })
})

describe('web baseline name', () => {
  const paths = ['apps/site/migrations/0000_previous_baseline.sql', 'apps/site/migrations/0000_web_baseline.sql']
  const sql = Buffer.from('CREATE TABLE example(id TEXT PRIMARY KEY);\n')
  it('accepts only the initial web baseline rename with identical SQL bytes', () => {
    expect(validateWebBaselineRename('apps/site/migrations', 'R100', paths, sql, sql)).toBe(true)
    expect(() => validateWebBaselineRename('apps/site/migrations', 'R100', paths, sql, Buffer.from('changed'))).toThrow('immutable')
  })
  it('rejects changes, other migration histories and arbitrary new names', () => {
    expect(validateWebBaselineRename('apps/site/migrations', 'R099', paths, sql, sql)).toBe(false)
    expect(validateWebBaselineRename('drizzle/migrations', 'R100', paths, sql, sql)).toBe(false)
    expect(validateWebBaselineRename('apps/site/migrations', 'R100', [paths[0], 'apps/site/migrations/0000_other.sql'], sql, sql)).toBe(false)
  })
})
