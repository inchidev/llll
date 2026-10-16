import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/dev-remote.mjs', import.meta.url))
const directories: string[] = []

function launch(args: string[], files: Record<string, string> = {}, overrides: Record<string, string> = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'llll-remote-')))
  directories.push(cwd)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text)
  const output = join(cwd, 'launch.json')
  const executable = join(cwd, 'pnpm')
  writeFileSync(executable, `#!${process.execPath}
require('node:fs').writeFileSync(process.env.LAUNCH_OUTPUT, JSON.stringify({
  args: process.argv.slice(2), origin: process.env.LLLL_DEV_PROXY_ORIGIN,
  marker: process.env.PROFILE_MARKER, defaultOnly: process.env.DEFAULT_ONLY,
}));
process.exit(Number(process.env.CHILD_EXIT_CODE || 0));
`)
  chmodSync(executable, 0o755)
  const result = spawnSync(process.execPath, [script, '--', ...args], {
    cwd,
    env: { PATH: `${cwd}:${dirname(process.execPath)}`, LAUNCH_OUTPUT: output, ...overrides },
    encoding: 'utf8',
  })
  return { ...result, cwd, output }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('remote development launcher', () => {
  it('uses a selected profile for both the launcher and Nuxt without loading the default file', () => {
    const result = launch(['--', '--env-file', '.env.personal'], {
      '.env': 'LLLL_DEV_PROXY_ORIGIN=https://wrong.example.com\nDEFAULT_ONLY=wrong\n',
      '.env.personal': 'LLLL_DEV_PROXY_ORIGIN=https://chat.example.com\nPROFILE_MARKER=personal\n',
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(result.output, 'utf8'))).toEqual({
      args: ['exec', 'nuxt', 'dev', '--dotenv', join(result.cwd, '.env.personal')],
      origin: 'https://chat.example.com', marker: 'personal',
    })
  })

  it('uses the default env file and preserves shell overrides', () => {
    const result = launch([], { '.env': 'LLLL_DEV_PROXY_ORIGIN=https://file.example.com\nPROFILE_MARKER=file\n' }, {
      LLLL_DEV_PROXY_ORIGIN: 'https://shell.example.com', PROFILE_MARKER: 'shell',
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(result.output, 'utf8'))).toMatchObject({ origin: 'https://shell.example.com', marker: 'shell' })
  })

  it('lets the URL override the shell and propagates the child exit code', () => {
    const result = launch(['https://override.example.com'], {}, {
      LLLL_DEV_PROXY_ORIGIN: 'https://shell.example.com', CHILD_EXIT_CODE: '7',
    })
    expect(result.status).toBe(7)
    expect(JSON.parse(readFileSync(result.output, 'utf8'))).toMatchObject({ origin: 'https://override.example.com' })
  })

  it('fails on a missing explicit file rather than silently using .env', () => {
    const result = launch(['--env-file', '.env.missing'], { '.env': 'LLLL_DEV_PROXY_ORIGIN=https://chat.example.com' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('selected env file does not exist')
  })

  it.each(['file:///private/config', 'https://user:password@example.com', 'https://chat.example.com/path'])('rejects invalid origins without printing their contents: %s', (url) => {
    const result = launch([url])
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain(url)
  })
})
