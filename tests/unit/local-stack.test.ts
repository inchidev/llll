import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
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
  return { root, state, envFile, configuration, calls, launch }
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

  it('reaps busy process groups and releases the lock when stopped during startup', async () => {
    const f = fixture()
    unlinkSync(join(f.state, 'dev.pid'))
    const portProbe = createServer()
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve))
    const address = portProbe.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await new Promise<void>(resolve => portProbe.close(() => resolve()))
    writeFileSync(f.envFile, f.configuration.replace('LLLL_FRONTEND_PORT=3001', `LLLL_FRONTEND_PORT=${address.port}`))
    const childPids = join(f.root, 'children')
    for (const name of ['node', 'pnpm']) {
      const executable = join(f.root, name)
      writeFileSync(executable, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(childPids)}, process.pid+'\\n');
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`)
      chmodSync(executable, 0o755)
    }
    const child = spawn(process.execPath, [join(f.root, 'scripts/local-stack.mjs'), 'dev', '--no-shell'], {
      cwd: f.root, env: { PATH: f.root + ':' + dirname(process.execPath), HOME: f.root }, stdio: 'ignore',
    })
    let pids: number[] = []
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        pids = existsSync(childPids) ? readFileSync(childPids, 'utf8').trim().split('\n').map(Number) : []
        if (pids.length === 2) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(pids).toHaveLength(2)
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(existsSync(join(f.state, 'dev.pid'))).toBe(false)
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
      expect(readFileSync(f.calls, 'utf8')).not.toContain('compose')
    } finally {
      child.kill('SIGKILL')
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL') } catch { /* Already reaped. */ } }
    }
  }, 10000)
})
