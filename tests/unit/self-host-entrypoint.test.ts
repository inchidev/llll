import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('renders private temporary config with celld-compatible paths to the read-only source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llll-entrypoint-'))
  try {
    const source = join(dir, 'application'), bin = join(dir, 'bin'), config = join(dir, 'runtime/wrangler.json')
    mkdirSync(join(source, 'public'), { recursive: true })
    mkdirSync(join(source, 'migrations'))
    mkdirSync(bin)
    writeFileSync(join(source, 'worker.mjs'), 'export default {}')
    writeFileSync(join(source, 'public/index.html'), 'L4')
    const template = JSON.stringify({ main: './worker.mjs', assets: { directory: 'public' }, d1_databases: [{ database_name: 'llll', migrations_dir: 'migrations' }], vars: {} })
    writeFileSync(join(source, 'wrangler.json'), template)
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // Stop at the real deployment boundary; do not start a daemon in this test.
    writeFileSync(join(bin, 'celld'), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
    const result = spawnSync('sh', [resolve('self-host/entrypoint.sh')], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, CELLD_TEMPLATE: join(source, 'wrangler.json'), CELLD_CONFIG: config,
        CELLD_WATCH: join(dir, 'data'), PUBLIC_ORIGIN: 'https://example.test',
        AUTH_SECRET: 'a'.repeat(32), SETUP_TOKEN: 'b'.repeat(32), AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture-secret',
      }, encoding: 'utf8', timeout: 10000,
    })
    expect(result.status, result.stderr).toBe(42)
    const rendered = JSON.parse(readFileSync(config, 'utf8'))
    for (const [path, original] of [
      [rendered.main, 'worker.mjs'], [rendered.assets.directory, 'public'], [rendered.d1_databases[0].migrations_dir, 'migrations'],
    ]) {
      // celld rejects absolute paths, '.' and '..' components.
      expect(path.startsWith('/')).toBe(false)
      expect(path.split('/')).not.toContain('..')
      expect(path.split('/')).not.toContain('.')
      expect(realpathSync(resolve(dirname(config), path))).toBe(realpathSync(join(source, original)))
    }
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(source, 'wrangler.json'), 'utf8')).toBe(template)
    expect(existsSync(join(source, 'wrangler.celld.local.json'))).toBe(false)
    expect(result.stdout + result.stderr).not.toContain('a'.repeat(32))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
