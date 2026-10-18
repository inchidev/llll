import { describe, expect, it } from 'vitest'
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
