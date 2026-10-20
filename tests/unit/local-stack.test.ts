import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(endpoint = 'unix:///local/docker.sock') {
  const root = mkdtempSync(join(tmpdir(), 'llll-stack-'))
  directories.push(root)
  mkdirSync(join(root, 'scripts'))
  copyFileSync(new URL('../../scripts/local-stack.mjs', import.meta.url), join(root, 'scripts/local-stack.mjs'))
  const state = join(root, '.deployment/dev-stack')
  mkdirSync(state, { recursive: true })
  const envFile = join(state, '.env')
  const configuration = `LLLL_PROJECT=local-fixture\nLLLL_DOCKER_CONTEXT=fixture\nLLLL_HTTP_PORT=3000\nLLLL_FRONTEND_PORT=3001\nLLLL_SHELL_ORIGIN=http://localhost:3002\nAUTH_SECRET=private-fixture-value\n`
  writeFileSync(envFile, configuration)
  writeFileSync(join(state, 'dev.pid'), String(process.pid))
  const calls = join(root, 'calls.jsonl')
  const docker = join(root, 'docker')
  writeFileSync(docker, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (args[0] === 'context' && args[1] === 'inspect') console.log(JSON.stringify([{Endpoints:{docker:{Host:${JSON.stringify(endpoint)}}}}]));
else if (args.includes('info')) console.log('28.0.0');
else { console.error('Unexpected Docker mutation'); process.exit(42); }
`)
  chmodSync(docker, 0o755)
  function launch(command: string) {
    return spawnSync(process.execPath, [join(root, 'scripts/local-stack.mjs'), command], {
      cwd: root,
      env: { PATH: root + ':' + dirname(process.execPath), HOME: root },
      encoding: 'utf8',
    })
  }
  return { state, envFile, configuration, calls, launch }
}

describe('standalone stack lifecycle guards', () => {
  it('refuses a second development process without stopping containers or replacing secrets', () => {
    const f = fixture()
    const result = f.launch('dev')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already has a running dev:stack')
    expect(readFileSync(f.envFile, 'utf8')).toBe(f.configuration)
    expect(readFileSync(join(f.state, 'dev.pid'), 'utf8')).toBe(String(process.pid))
    expect(readFileSync(f.calls, 'utf8')).not.toContain('compose')
  })

  it('refuses a mode change while the development process holds the worktree lock', () => {
    const f = fixture()
    const result = f.launch('up')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('before changing modes')
    expect(readFileSync(f.calls, 'utf8')).not.toContain('compose')
  })

  it('refuses remote Docker before checking the daemon or mutating resources', () => {
    const f = fixture('ssh://operator@remote.example')
    const result = f.launch('dev')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('remote Docker hosts are refused')
    const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toEqual([['context', 'inspect', 'fixture']])
  })
})
