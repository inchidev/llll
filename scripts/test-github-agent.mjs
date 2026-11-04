import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare'

// Real workerd/WebCrypto/fetch; only GitHub is replaced. No live App credentials.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const bundle = await build({
  stdin: { contents: `
    import { githubAgentClient, agentRepositories } from './server/utils/github-agent-client.ts';
    export default { async fetch(request, env) {
      try {
        if (new URL(request.url).pathname === '/discover') return Response.json(await agentRepositories(env));
        const client = await githubAgentClient(env, { installationId: 101, repositoryId: 11, access: 'read' });
        return Response.json(await client.json('/repos/source/project'));
      } catch (error) { return Response.json({ error: error.data?.error?.code || 'unexpected' }, { status: error.statusCode || 500 }); }
    } };
  `, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  loader: { '.sql': 'text' },
  absWorkingDir: resolve('.'),
})
let redirectAt = null
const requests = []
const runtime = new Miniflare(convertV4MiniflareOptions({
  cf: false, log: new Log(LogLevel.WARN),
  workers: [{
    name: 'github-agent-transport', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'],
    bindings: { GITHUB_AGENT_APP_ID: '4242', GITHUB_AGENT_APP_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() },
    outboundService: async request => {
      const url = new URL(request.url)
      assert.equal(url.origin, 'https://api.github.com')
      requests.push({ path: url.pathname, method: request.method })
      if (url.pathname === redirectAt) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/private' } })
      if (url.pathname === '/app/installations') return Response.json([{ id: 101, suspended_at: null }])
      if (url.pathname === '/app/installations/101/access_tokens') {
        const body = await request.json()
        assert.deepEqual(body.permissions, body.repository_ids ? { contents: 'read' } : { metadata: 'read' })
        return Response.json({ token: 'synthetic-repository-token' })
      }
      assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-repository-token')
      if (url.pathname === '/repos/source/project') return Response.json({ id: 11, full_name: 'source/project' })
      if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ id: 11, full_name: 'source/project', archived: false, fork: false, default_branch: 'main' }] })
      if (url.pathname === '/installation/token' && request.method === 'DELETE') return new Response(null, { status: 204 })
      throw Error('Unexpected broker operation')
    },
  }],
}))
try {
  let response = await runtime.dispatchFetch('https://fixture.invalid/read')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 11, full_name: 'source/project' })
  response = await runtime.dispatchFetch('https://fixture.invalid/discover')
  assert.equal(response.status, 200)
  assert.equal((await response.json())[0].id, 11)
  assert.equal(requests.at(-1).path, '/installation/token')
  for (const path of ['/app/installations', '/app/installations/101/access_tokens', '/installation/repositories', '/installation/token']) {
    redirectAt = path
    response = await runtime.dispatchFetch('https://fixture.invalid/discover')
    assert.equal(response.status, 502, path)
    assert.deepEqual(await response.json(), { error: 'github_failed' })
  }
  redirectAt = '/app/installations/101/access_tokens'
  response = await runtime.dispatchFetch('https://fixture.invalid/read')
  assert.equal(response.status, 502)
  console.log('PASS: workerd GitHub App token minting, repository discovery, capability revocation and redirect rejection')
} finally { await runtime.dispose() }
