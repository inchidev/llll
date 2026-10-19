import { describe, expect, it } from 'vitest'
import {
  createError,
  durableObjectMigrations,
  emailRoutingEnableBody,
  hostnameInsideZone,
  loadL4Release,
  parseBaseInstallRequest,
  parseDeployRequest,
  releaseManifestUrl,
  updateWorkerBindings,
  type InstallerReleaseManifest,
} from '../../../packages/deployment-core/src/index'

const request = {
  accountId: 'a'.repeat(32),
  workerName: 'LLLL-HQ',
  adminEmail: 'OWNER@EXAMPLE.COM',
  allowedEmails: [],
  appName: 'HQ',
  authMode: 'builtin',
  registrationMode: 'invite_only',
  customDomainEnabled: true,
  zoneId: 'b'.repeat(32),
  zoneName: 'example.com',
  appSubdomain: 'hq',
  mailEnabled: true,
  mailSubdomain: 'hq',
  mailLocalPart: 'inbox',
} as const

describe('published installer core integration', () => {
  it('keeps shared errors compatible with public H3 status messages', () => {
    expect(createError({ statusCode: 400, statusMessage: 'Cloudflare rejected the domain' })).toMatchObject({
      statusCode: 400,
      statusMessage: 'Cloudflare rejected the domain',
      message: 'Cloudflare rejected the domain',
    })
  })

  it('normalizes the web installer request with the shared contract', () => {
    expect(parseDeployRequest(request)).toMatchObject({
      workerName: 'llll-hq',
      adminEmail: 'owner@example.com',
      mailEnabled: true,
    })
  })

  it('keeps optional domains and mail outside the guided base-install contract', () => {
    const base = parseBaseInstallRequest(request)
    expect(base).toMatchObject({ workerName: 'llll-hq', appName: 'HQ' })
    expect(base).not.toHaveProperty('customDomainEnabled')
    expect(base).not.toHaveProperty('zoneId')
    expect(base).not.toHaveProperty('mailEnabled')
  })

  it('enables Email Routing without a subdomain body for the zone apex', () => {
    const zone = { id: 'zone', accountId: 'account', name: 'example.com', status: 'active' } as const

    expect(emailRoutingEnableBody(zone, 'example.com')).toBeUndefined()
    expect(emailRoutingEnableBody(zone, 'mail.example.com')).toBe('{"name":"mail.example.com"}')
  })

  it('turns a hostname label into a hostname inside the selected zone', () => {
    const zone = { id: 'zone', accountId: 'account', name: 'llll.gg', status: 'active' } as const

    expect(hostnameInsideZone(zone, 'inchi')).toBe('inchi.llll.gg')
    expect(hostnameInsideZone(zone, 'inchi.llll.gg')).toBe('inchi.llll.gg')
    expect(() => hostnameInsideZone(zone, 'inchi.example.com')).toThrow('Enter a hostname inside the selected active Cloudflare zone')
  })

  it('preserves Server secrets and domain configuration during an update', () => {
    const manifest = {
      version: '0.1.1',
      durableObjects: [{ binding: 'CHANNEL_DO', className: 'ChannelDurableObject', migration: 'v1' }],
    } as InstallerReleaseManifest
    const bindings = updateWorkerBindings([
      { type: 'plain_text', name: 'LLLL_VERSION', text: '0.1.0' },
      { type: 'plain_text', name: 'LLLL_EMAIL_DOMAINS', text: '[{"domain":"afterprompt.games"}]' },
      { type: 'secret_text', name: 'AUTH_SECRET' },
      { type: 'send_email', name: 'MAIL_EMAIL' },
      { type: 'assets', name: 'ASSETS' },
      { type: 'durable_object_namespace', name: 'CHANNEL_DO', class_name: 'ChannelDurableObject' },
    ], manifest)

    expect(bindings).toContainEqual({ type: 'inherit', name: 'LLLL_EMAIL_DOMAINS' })
    expect(bindings).toContainEqual({ type: 'inherit', name: 'AUTH_SECRET' })
    expect(bindings).toContainEqual({ type: 'inherit', name: 'MAIL_EMAIL' })
    expect(bindings).toContainEqual({ type: 'inherit', name: 'CHANNEL_DO' })
    expect(bindings).toContainEqual({ type: 'plain_text', name: 'LLLL_VERSION', text: '0.1.1' })
    expect(bindings.filter(binding => binding.name === 'ASSETS')).toEqual([{ type: 'assets', name: 'ASSETS' }])
  })

  it('pins requested updates to immutable GitHub Release manifests', () => {
    expect(releaseManifestUrl('v0.3.0')).toBe(
      'https://github.com/inchidev/llll/releases/download/v0.3.0/llll-cloudflare-manifest.json',
    )
    expect(releaseManifestUrl('0.3.0')).toBe(
      'https://github.com/inchidev/llll/releases/download/v0.3.0/llll-cloudflare-manifest.json',
    )
  })

  it('accepts the base release contract without CLI or Container metadata', async () => {
    const worker = new TextEncoder().encode('worker')
    const assets = new TextEncoder().encode(JSON.stringify({ assets: [], migrations: [] }))
    const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
    const manifestUrl = 'https://example.com/llll-cloudflare-manifest.json'
    const manifest = {
      schemaVersion: 1,
      version: '0.0.2',
      releasedAt: '2026-09-20T00:00:00.000Z',
      compatibilityDate: '2026-09-02',
      compatibilityFlags: ['nodejs_compat'],
      capabilities: ['llll-server-schema-v1'],
      worker: { url: './llll-worker.mjs', sha256: await digest(worker), size: worker.byteLength },
      assets: { url: './llll-assets.json', sha256: await digest(assets), size: assets.byteLength },
      durableObjects: [],
    }
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input)
      if (url === manifestUrl) return Response.json(manifest)
      if (url.endsWith('/llll-worker.mjs')) return new Response(worker)
      if (url.endsWith('/llll-assets.json')) return new Response(assets)
      return new Response(null, { status: 404 })
    }

    await expect(loadL4Release(manifestUrl, fetcher as typeof fetch)).resolves.toMatchObject({
      manifest: { version: '0.0.2' },
      assets: { assets: [], migrations: [] },
    })
  })

  it('deploys release Durable Objects on a fresh server', () => {
    const manifest = {
      durableObjects: [
        { binding: 'AGENT_DO', className: 'L4Agent', migration: 'v3' },
      ],
    } as InstallerReleaseManifest

    expect(durableObjectMigrations(manifest, { exists: false })).toEqual({
      new_tag: 'v3',
      steps: [{ new_sqlite_classes: ['L4Agent'] }],
    })
  })
})
