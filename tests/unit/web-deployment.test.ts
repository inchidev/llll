import { afterEach, expect, it, vi } from 'vitest'
import {
  advanceDeployment,
  deploymentParameters,
  listReleases,
  VERSION_PATTERN,
} from '../../apps/site/src/deploy'
import { digest, type DeploymentState } from '../../apps/site/src/session'
afterEach(() => vi.unstubAllGlobals())
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
            capabilities: ['llll-server-schema-v1'],
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
    if (input.includes('api.github.com')) return new Response('', { status: 403 })
    if (input.endsWith('/releases.atom')) return new Response(`<feed><entry><id>tag:github.com,2008:Repository/1424308136/v0.1.0-alpha.4</id><title>L4 &amp; community</title><updated>2026-10-18T17:00:00Z</updated></entry><entry><id>invalid/../../other</id></entry></feed>`)
    if (input.endsWith('/SHA256SUMS')) return new Response(`${'a'.repeat(64)}  llll-deployment.json\n${'b'.repeat(64)}  llll-cloudflare-manifest.json\n`)
    return Response.json({ version: '0.1.0-alpha.4', capabilities: ['llll-server-schema-v1'] })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await listReleases()).toEqual([{ version: 'v0.1.0-alpha.4', name: 'L4 & community', published_at: '2026-10-18T17:00:00Z', notes_url: 'https://github.com/inchidev/llll/releases/tag/v0.1.0-alpha.4' }])
  expect(fetcher.mock.calls.some(([url]) => url.includes('/other'))).toBe(false)
})
it('does not offer feed releases with incomplete assets or a mismatched manifest', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('api.github.com')) return new Response('', { status: 429 })
    if (input.endsWith('/releases.atom')) return new Response('<feed><entry><id>repo/v0.1.0-alpha.4</id></entry><entry><id>repo/v0.1.0-alpha.5</id></entry></feed>')
    if (input.includes('/v0.1.0-alpha.4/')) return new Response(`${'a'.repeat(64)}  llll-cloudflare-manifest.json\n`)
    if (input.endsWith('/SHA256SUMS')) return new Response(`${'a'.repeat(64)}  llll-deployment.json\n${'b'.repeat(64)}  llll-cloudflare-manifest.json\n`)
    return Response.json({ version: '0.1.0-alpha.4', capabilities: ['llll-server-schema-v1'] })
  }))
  expect(await listReleases()).toEqual([])
})
it('resumes server creation through Workers Builds without uploading application code and retains the grant for the bounded installer session', async () => {
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
  const calls: { path: string; method: string }[] = []
  let ready = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options?: RequestInit) => {
      const url = new URL(input)
      calls.push({ path: url.pathname, method: options?.method || 'GET' })
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
      let result: unknown = {}
      if (url.pathname.endsWith('/builds/tokens'))
        result = [{ build_token_uuid: 'build-token' }]
      else if (
        url.pathname.endsWith('/workers/workers') &&
        options?.method === 'POST'
      )
        result = { id: 'worker-tag' }
      else if (url.pathname.endsWith('/workers/workers')) result = []
      else if (url.pathname.endsWith('/repos/connections'))
        result = { repo_connection_uuid: 'repo' }
      else if (url.pathname.endsWith('/workers/subdomain'))
        result = { subdomain: 'test' }
      else if (url.pathname.endsWith('/workers/worker-tag/triggers'))
        result = []
      else if (url.pathname.endsWith('/builds/triggers'))
        result = { trigger_uuid: 'trigger' }
      else if (url.pathname.endsWith('/triggers/trigger/builds'))
        result = { build_uuid: 'build' }
      else if (url.pathname.endsWith('/builds/builds/build'))
        result = { status: 'running' }
      return Response.json({ success: true, result })
    }),
  )
  const env = { PUBLIC_ORIGIN: 'https://llll.gg' } as Parameters<
    typeof advanceDeployment
  >[1]
  await advanceDeployment(state, env, async () => {})
  expect(state.step).toBe(1)
  await advanceDeployment(state, env, async () => {})
  expect(state.step).toBe(2)
  await advanceDeployment(state, env, async () => {})
  expect(state.completed).not.toBe(true)
  ready = true
  await advanceDeployment(state, env, async () => {})
  expect(state.completed).toBe(true)
  expect(state.grant?.accessToken).toBe('private')
  expect(state.deployments).toEqual([expect.objectContaining({ origin: state.origin, setupToken: state.setupToken })])
  expect(
    calls.filter(
      (c) => c.path.endsWith('/workers/workers') && c.method === 'POST',
    ),
  ).toHaveLength(1)
  expect(
    calls.some(
      (c) =>
        c.path.includes('/workers/scripts/') ||
        c.path.includes('/assets-upload-session'),
    ),
  ).toBe(false)
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
