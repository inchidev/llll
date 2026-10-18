import { describe, expect, it } from 'vitest'
import { pullRequestCandidate, verifyMergeParents } from '../../scripts/pull-request-ref.mjs'
import { requireWorkersBuild } from '../../scripts/ci-only.mjs'

describe('deployment runner boundary', () => {
  it('rejects developer machines and generic CI', () => {
    expect(() => requireWorkersBuild({})).toThrow('never deploy from this machine')
    expect(() => requireWorkersBuild({ CI: 'true' })).toThrow()
  })
  it('accepts an identified Cloudflare Workers Build', () => {
    expect(() => requireWorkersBuild({ CI: 'true', WORKERS_CI: '1', WORKERS_CI_BUILD_UUID: 'build-id' })).not.toThrow()
  })
})

describe('PR Git verification', () => {
  const main = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const refs = `${main}\trefs/heads/main\n${head}\trefs/heads/codex/change\n${head}\trefs/pull/5/head\n${'c'.repeat(40)}\trefs/pull/5/merge`
  it('finds the exact branch head with a merge ref', () => {
    expect(pullRequestCandidate(refs, 'codex/change', head)).toEqual({ number: 5, main, head })
  })
  it('rejects stale commits, missing branches and closed PR refs', () => {
    expect(pullRequestCandidate(refs, 'codex/change', main)).toBeNull()
    expect(pullRequestCandidate(refs, 'codex/other', head)).toBeNull()
    expect(pullRequestCandidate(refs.split('\n').slice(0, -1).join('\n'), 'codex/change', head)).toBeNull()
  })
  it('requires both merge parents in the right order', () => {
    const candidate = { number: 5, main, head }
    expect(verifyMergeParents(`tree ${main}\nparent ${main}\nparent ${head}\n\nMerge`, candidate)).toBe(true)
    expect(verifyMergeParents(`parent ${head}\nparent ${main}\n\nMerge`, candidate)).toBe(false)
    expect(verifyMergeParents(`parent ${head}\n\nparent ${main}`, candidate)).toBe(false)
  })
})
