import { afterEach, expect, it, vi } from 'vitest'
import {
  advanceDeployment,
  deploymentParameters,
  listReleases,
  VERSION_PATTERN,
} from '../../apps/site/src/deploy'
import { installL4 } from '../../packages/deployment-core/src/installer'
import { digest, type DeploymentState } from '../../apps/site/src/session'

/** Mocks route by exact host; a substring check would also match look-alike hosts. */
const hostname = (value: string) => { try { return new URL(value).hostname } catch { return '' } }

vi.mock('../../packages/deployment-core/src/installer', () => ({ installL4: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(installL4).mockReset() })
it('lists complete published releases and rejects malformed versions', async () => {
  const release = {
    tag_name: 'v0.1.0-alpha.3',
    assets: [
      'llll-deployment.json',
      'llll-cloudflare-manifest.json',
      'SHA256SUMS',
    ].map((name) => ({ name })),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.endsWith('/llll-cloudflare-manifest.json')
        ? Response.json({
            version: '0.1.0-alpha.3',
            capabilities: ['llll-server-schema-v2'],
          })
        : Response.json([
            release,
            { ...release, draft: true },
            { ...release, assets: [] },
          ]),
    ),
  )
  expect(await listReleases()).toHaveLength(1)
  expect(VERSION_PATTERN.test('v0.1.0-alpha.3/../other')).toBe(false)
})
it('uses the public release feed when the shared GitHub REST quota is exhausted', async () => {
  const fetcher = vi.fn(async (input: string) => {
    if (hostname(input) === 'api.github.com') return new Response('', { status: 403 })
    if (input.endsWith('/releases.atom')) return new Response(`<feed><entry><id>tag:github.com,2008:Repository/1424308136/v0.1.0-alpha.4</id><title>L4 &amp; community</title><updated>2026-10-18T17:00:00Z</updated></entry><entry><id>invalid/../../other</id></entry></feed>`)
    if (input.endsWith('/SHA256SUMS')) return new Response(`${'a'.repeat(64)}  llll-deployment.json\n${'b'.repeat(64)}  llll-cloudflare-manifest.json\n`)
    return Response.json({ version: '0.1.0-alpha.4', capabilities: ['llll-server-schema-v2'] })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await listReleases()).toEqual([{ version: 'v0.1.0-alpha.4', name: 'L4 & community', published_at: '2026-10-18T17:00:00Z', notes_url: 'https://github.com/inchidev/llll/releases/tag/v0.1.0-alpha.4' }])
  expect(fetcher.mock.calls.some(([url]) => url.includes('/other'))).toBe(false)
})
it('does not offer feed releases with incomplete assets or a mismatched manifest', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (hostname(input) === 'api.github.com') return new Response('', { status: 429 })
    if (input.endsWith('/releases.atom')) return new Response('<feed><entry><id>repo/v0.1.0-alpha.4</id></entry><entry><id>repo/v0.1.0-alpha.5</id></entry></feed>')
    if (input.includes('/v0.1.0-alpha.4/')) return new Response(`${'a'.repeat(64)}  llll-cloudflare-manifest.json\n`)
    if (input.endsWith('/SHA256SUMS')) return new Response(`${'a'.repeat(64)}  llll-deployment.json\n${'b'.repeat(64)}  llll-cloudflare-manifest.json\n`)
    return Response.json({ version: '0.1.0-alpha.4', capabilities: ['llll-server-schema-v2'] })
  }))
  expect(await listReleases()).toEqual([])
})
it('installs the checksum-verified release through the OAuth grant and retains the grant for the bounded installer session', async () => {
  const code = 'export default {}'
  const artifact = JSON.stringify({
    schemaVersion: 3,
    version: '0.1.0-alpha.3',
    modules: { server: { content: code, sha256: await digest(code) } },
    assets: [],
    migrations: { server: [] },
  })
  const state: DeploymentState = {
    ...deploymentParameters(
      'a'.repeat(32),
      'Community',
      'v0.1.0-alpha.3',
      'owner@example.com',
    ),
    grant: {
      accessToken: 'private',
      refreshToken: 'private-refresh',
      clientId: 'client',
      expiresAt: Date.now() + 3600000,
    },
  }
  const calls: string[] = []
  let ready = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      calls.push(url.hostname + url.pathname)
      if (url.hostname === 'github.com')
        return url.pathname.endsWith('/SHA256SUMS')
          ? new Response(`${await digest(artifact)}  llll-deployment.json\n`)
          : new Response(artifact)
      if (url.pathname === '/.well-known/llll')
        return ready
          ? Response.json({
              kind: 'server',
              origin: state.origin,
              version: '0.1.0-alpha.3',
            })
          : new Response('', { status: 503 })
      throw new Error(`Unexpected request: ${url}`)
    }),
  )
  vi.mocked(installL4).mockResolvedValue({
    url: 'https://community.test.workers.dev',
    setupUrl: `https://community.test.workers.dev/setup#claim=${state.setupToken}`,
    version: '0.1.0-alpha.3',
    updated: false,
    appliedMigrations: [],
    verified: false,
  })
  const env = { PUBLIC_ORIGIN: 'https://llll.gg' } as Parameters<
    typeof advanceDeployment
  >[1]
  await advanceDeployment(state, env, async () => {})
  expect(state.step).toBe(1)
  expect(installL4).not.toHaveBeenCalled()
  await advanceDeployment(state, env, async () => {})
  expect(state.step).toBe(2)
  expect(state.origin).toBe('https://community.test.workers.dev')
  expect(installL4).toHaveBeenCalledWith(
    'private',
    expect.objectContaining({
      accountId: 'a'.repeat(32),
      workerName: state.worker,
      targetVersion: 'v0.1.0-alpha.3',
      adminEmail: 'owner@example.com',
      backupBucketName: state.worker + '-backups',
    }),
    expect.objectContaining({ verify: false, setupToken: state.setupToken, report: expect.any(Function) }),
  )
  await advanceDeployment(state, env, async () => {})
  expect(state.completed).not.toBe(true)
  ready = true
  await advanceDeployment(state, env, async () => {})
  expect(state.completed).toBe(true)
  expect(state.grant?.accessToken).toBe('private')
  expect(state.deployments).toEqual([expect.objectContaining({ origin: state.origin, setupToken: state.setupToken })])
  expect(calls.some((call) => hostname(call) === 'api.cloudflare.com')).toBe(false)
})
it('refuses an unsupported release format before creating resources', async () => {
  const code = 'export default {}'
  const artifact = JSON.stringify({
    schemaVersion: 1,
    version: '0.1.0-alpha.2',
    modules: { server: { content: code, sha256: await digest(code) } },
    assets: [],
  })
  const state: DeploymentState = {
    ...deploymentParameters(
      'a'.repeat(32),
      'Community',
      'v0.1.0-alpha.2',
      'owner@example.com',
    ),
    grant: {
      accessToken: 'private',
      refreshToken: 'refresh',
      clientId: 'client',
      expiresAt: Date.now() + 3600000,
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.endsWith('/SHA256SUMS')
        ? new Response(`${await digest(artifact)}  llll-deployment.json\n`)
        : new Response(artifact),
    ),
  )
  await expect(
    advanceDeployment(state, {} as never, async () => {}),
  ).rejects.toThrow('release bundle')
})

it('persists deployment progress while provisioning, before the long request finishes', async () => {
  const state: DeploymentState = { ...deploymentParameters('a'.repeat(32), 'Community', 'v0.2.8', 'owner@example.com'), step: 1,
    grant: { accessToken: 'private', refreshToken: 'private', clientId: 'client', expiresAt: Date.now() + 3600000 } }
  const snapshots: unknown[] = []
  vi.mocked(installL4).mockImplementationOnce(async (_token, _request, options) => {
    expect(options?.report).toBeTypeOf('function')
    await options!.report!({ type: 'progress', step: 'storage', state: 'complete', detail: 'Basic file storage (KV) ready; backups download to your device' })
    expect(snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ progress: expect.arrayContaining([expect.objectContaining({ step: 'storage' })]) })]))
    throw new Error('Provisioning paused')
  })
  await expect(advanceDeployment(state, {} as never, async () => { snapshots.push(structuredClone(state)) })).rejects.toThrow('Provisioning paused')
  expect(state.serverId).toBeDefined()
})
it('classifies email-verification errors without exposing upstream payloads', async () => {
  const { deploymentFailure } = await import('../../apps/site/src/deploy')
  expect(deploymentFailure(new Error('You need to verify your email address to use Workers. private-sentinel'))).toEqual({ message: 'Verify your Cloudflare email, then reconnect Cloudflare and resume this deployment.', reconnect: true })
  expect(deploymentFailure(Object.assign(new Error('private-sentinel'), { statusCode: 403 })).reconnect).toBe(true)
  expect(deploymentFailure(new Error('private-sentinel')).message).not.toContain('private-sentinel')
})
