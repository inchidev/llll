import { afterEach, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { advanceDeployment, deploymentParameters } from '../../apps/site/src/deploy'
import { digest, type DeploymentState } from '../../apps/site/src/session'
import { decryptSecret } from '../../shared/encrypted-secret'

afterEach(() => vi.unstubAllGlobals())
it('resumes an interrupted upload without replacing resources and hands the encrypted grant to the installation', async () => {
  const control = new DatabaseSync(':memory:')
  const module = 'export default {fetch(){return new Response("L4")}}'
  const artifact = JSON.stringify({ schemaVersion: 1, version: '0.2.0', modules: { installation: { content: module, sha256: await digest(module) } }, assets: [], migrations: { installation: [{ name: '0000_test.sql', sql: 'CREATE TABLE integration_settings(key TEXT PRIMARY KEY,value TEXT);' }] } })
  const artifactHash = await digest(artifact)
  const sums = `${artifactHash}  llll-deployment.json\n`
  const state: DeploymentState = { ...deploymentParameters('a'.repeat(32), 'Community', 'v0.2.0'), grant: { accessToken: 'private-access', refreshToken: 'private-refresh', clientId: 'public-client', expiresAt: Date.now() + 3600000 } }
  const originalSecret = state.authSecret!
  const name = state.worker!
  let databaseCreates = 0; let uploadAttempts = 0
  const snapshots: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input)
    if (url.hostname === 'github.com' && url.pathname.endsWith('/SHA256SUMS')) return new Response(sums)
    if (url.hostname === 'github.com' && url.pathname.endsWith('/llll-deployment.json')) return new Response(artifact)
    if (url.pathname === '/.well-known/llll') return Response.json({ product: 'llll', origin: state.origin, ready: false })
    let result: unknown = {}
    if (url.pathname.endsWith('/workers/subdomain')) result = { subdomain: 'test' }
    else if (url.pathname.endsWith('/d1/database') && options?.method === 'POST') { databaseCreates++; result = { uuid: 'database' } }
    else if (url.pathname.endsWith('/d1/database')) result = []
    else if (url.pathname.endsWith('/r2/buckets') && options?.method === 'GET') result = { buckets: [] }
    else if (url.pathname.endsWith('/query')) {
      const body = JSON.parse(String(options?.body))
      if (body.params) { control.prepare(body.sql).run(...body.params); result = [{ results: [] }] }
      else if (body.sql.startsWith('SELECT')) result = [{ results: control.prepare(body.sql).all() }]
      else { control.exec(body.sql); result = [{ results: [] }] }
    }
    else if (url.pathname.endsWith('/assets-upload-session')) result = { jwt: 'asset-completion', buckets: [] }
    else if (url.pathname.endsWith('/workers/scripts/' + name) && options?.method === 'PUT') {
      uploadAttempts++
      if (uploadAttempts === 1) throw new Error('Interrupted upload')
      const form = options.body as FormData
      const metadata = JSON.parse(String(form.get('metadata')))
      expect(JSON.stringify(metadata)).not.toContain('private-access')
      expect(metadata.bindings.find((b: { name: string }) => b.name === 'AUTH_SECRET').text).toBe(originalSecret)
    }
    return Response.json({ success: true, result })
  }))
  const env = { PUBLIC_ORIGIN: 'https://portal.example' }
  const save = async () => { snapshots.push(JSON.stringify(state)) }
  // Only the deployment fields are needed by this engine; it does not access portal storage.
  await advanceDeployment(state, env as Parameters<typeof advanceDeployment>[1], save)
  expect(state.step).toBe(1)
  await expect(advanceDeployment(state, env as Parameters<typeof advanceDeployment>[1], save)).rejects.toThrow('Interrupted upload')
  expect(state.worker).toBe(name); expect(state.authSecret).toBe(originalSecret)
  await advanceDeployment(state, env as Parameters<typeof advanceDeployment>[1], save)
  expect(state.step).toBe(2)
  await advanceDeployment(state, env as Parameters<typeof advanceDeployment>[1], save)
  expect(state.completed).toBe(true); expect(state.grant).toBeUndefined(); expect(state.authSecret).toBeUndefined()
  expect(databaseCreates).toBe(1); expect(uploadAttempts).toBe(2)
  const encrypted = control.prepare('SELECT value FROM integration_settings WHERE key=?').get('CLOUDFLARE_OAUTH_GRANT')!
  expect(String(encrypted.value)).not.toContain('private-refresh')
  const grant = JSON.parse(await decryptSecret(originalSecret, 'settings:CLOUDFLARE_OAUTH_GRANT', JSON.parse(String(encrypted.value))))
  expect(grant.refreshToken).toBe('private-refresh')
  expect(snapshots.at(-1)).not.toContain('private-refresh')
  control.close()
})
