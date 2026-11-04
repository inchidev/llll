import { describe, expect, it, vi } from 'vitest'
import { createError } from '../../packages/deployment-core/src/errors'
import { connectManagedAppDomain, readManagedServerDomains } from '../../server/utils/server-infrastructure'
import type { L4Env } from '../../workers/env'

describe('server infrastructure ownership', () => {
  it('does not call a public control plane when reading local deployment metadata', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(readManagedServerDomains({} as L4Env)).resolves.toEqual({ managed: false, source: 'operator', direct: false, primary: null, origins: [], pending: [], zones: [], appDomain: null, emailDomains: [] })
      expect(network).not.toHaveBeenCalled()
    }
    finally { network.mockRestore() }
  })

  it('rejects unsupported domain mutation instead of returning a fake success or installer redirect', async () => {
    vi.stubGlobal('createError', createError)
    try { await expect(connectManagedAppDomain({} as L4Env, { zoneId: 'zone', hostname: 'chat.example.com' })).rejects.toMatchObject({ statusCode: 409 }) }
    finally { vi.unstubAllGlobals() }
  })
})
