import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Cloudflare Workers reject fetch(..., { redirect: 'error' }) outright, so a
// request that worked in Node fails on every real Server. Use 'manual' and
// treat a 3xx as a failed response.
const roots = ['server', 'workers', 'shared', 'packages/deployment-core/src', 'apps/site/src']
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mjs|js)$/u.test(name) ? [path] : []
  })
}

it('never asks Workers fetch to error on redirects', () => {
  const offenders = roots.flatMap(files).filter(path => /redirect:\s*['"]error['"]/u.test(readFileSync(path, 'utf8')))
  expect(offenders).toEqual([])
})
