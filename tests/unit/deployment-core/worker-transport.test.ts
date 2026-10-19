import { afterEach, expect, it, vi } from 'vitest'
import { deployL4Update, type InstallerReleaseManifest } from '../../../packages/deployment-core/src/index'

afterEach(() => vi.unstubAllGlobals())

it('keeps same-account transport enabled when updating from an older immutable manifest', async () => {
  const asset = { url: 'https://releases.example/asset', sha256: 'a'.repeat(64), size: 0 }
  const manifest: InstallerReleaseManifest = {
    schemaVersion: 1, version: '0.1.0-alpha.1', releasedAt: '2026-10-18',
    compatibilityDate: '2026-09-28', compatibilityFlags: ['nodejs_compat'],
    worker: asset, assets: asset,
    durableObjects: [{ binding: 'CHANNEL_DO', className: 'ChannelDurableObject', migration: 'v1' }],
  }
  let uploadedFlags: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    let result: unknown
    if (path === '/client/v4/accounts/account') result = { id: 'account' }
    else if (path.endsWith('/workers/scripts')) result = [{ id: 'community', migration_tag: 'v1' }]
    else if (path.endsWith('/settings')) result = { bindings: [
      { name: 'LLLL_SERVER_MARKER', type: 'plain_text', text: 'llll.gg/server-v1' },
      { name: 'LLLL_APP_HOSTNAME', type: 'plain_text', text: 'community.example.com' },
      { name: 'DB', type: 'd1', database_id: 'original-database' },
      { name: 'CHANNEL_DO', type: 'durable_object_namespace', class_name: 'ChannelDurableObject' },
    ] }
    else if (path.endsWith('/query')) result = [{ results: [] }]
    else if (path.endsWith('/assets-upload-session')) result = { jwt: 'asset-completion', buckets: [] }
    else if (path.endsWith('/workers/scripts/community') && init?.method === 'PUT') {
      const form = init.body as FormData
      uploadedFlags = JSON.parse(String(form.get('metadata'))).compatibility_flags
      result = {}
    }
    else throw new Error(`Unexpected Cloudflare request: ${path}`)
    return Response.json({ success: true, result, result_info: { page: 1, total_pages: 1 } })
  }))

  await deployL4Update('private-token', 'account', 'community', {
    manifest, worker: new ArrayBuffer(0), assets: { assets: [], migrations: [] },
  }, { verify: false })

  expect(uploadedFlags).toContain('nodejs_compat')
  expect(uploadedFlags).toContain('global_fetch_strictly_public')
  expect(manifest.compatibilityFlags).toEqual(['nodejs_compat'])
})
