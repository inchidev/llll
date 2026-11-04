import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }) })

function probe(body: string, { migrated = true, curlStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'llll-health-'))
  fixtures.push(dir)
  mkdirSync(join(dir, 'bin'))
  if (migrated) writeFileSync(join(dir, '.migrations-applied'), '')
  writeFileSync(join(dir, 'bin/curl'), '#!/bin/sh\ntouch "$CELLD_WATCH/requested"\nprintf "%s" "$HEALTH_BODY"\nexit "$CURL_STATUS"\n', { mode: 0o755 })
  const result = spawnSync('sh', [resolve('self-host/healthcheck.sh')], {
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CELLD_WATCH: dir, HEALTH_BODY: body, CURL_STATUS: String(curlStatus) },
    encoding: 'utf8',
  })
  return { ...result, requested: existsSync(join(dir, 'requested')) }
}

describe('container readiness', () => {
  it('accepts a migrated Server before its first Owner claims it', () => {
    expect(probe('{"ok":true,"migrated":true,"ready":false}').status).toBe(0)
  })

  it.each([
    '{"ok":false,"migrated":false,"ready":false}',
    '{"ok":true,"migrated":false}',
    '{"ok":"true","migrated":true}',
    '{}', 'null', '', '<html>unavailable</html>',
    '{"ok":false}\n{"ok":true,"migrated":true}',
  ])('rejects an HTTP 200 response that is not a healthy Server: %s', (body) => {
    const result = probe(body)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
  })

  it('does not call the app before migrations finish', () => {
    const result = probe('{"ok":true,"migrated":true}', { migrated: false })
    expect(result.status).not.toBe(0)
    expect(result.requested).toBe(false)
  })

  it('rejects a failed HTTP transfer even with an apparently healthy partial body', () => {
    expect(probe('{"ok":true,"migrated":true}', { curlStatus: 28 }).status).not.toBe(0)
  })
})
