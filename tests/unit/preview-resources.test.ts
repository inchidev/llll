import { describe, expect, it } from 'vitest'
import { buildPreviewConfigs, previewResourceNames } from '../../scripts/preview-resources.mjs'
import { previewComment, previewDeployment, wranglerPreviewOutput } from '../../scripts/preview-report.mjs'

const production = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: 'llll-sandbox',
  main: '.output/server/index.mjs',
  compatibility_date: '2026-09-28',
  preview_urls: true,
  assets: { binding: 'ASSETS', directory: '.output/public' },
  routes: [{ pattern: 'sandbox.llll.gg', custom_domain: true }],
  triggers: { crons: ['17 4 * * 1'] },
  placement: { mode: 'smart' },
  ai: { binding: 'AI' },
  browser: { binding: 'BROWSER' },
  d1_databases: [{ binding: 'DB', database_name: 'production-db', database_id: 'production-d1' }],
  r2_buckets: [{ binding: 'FILES', bucket_name: 'production-files' }],
  kv_namespaces: [{ binding: 'TICKETS', id: 'production-kv' }],
  durable_objects: { bindings: [{ name: 'CHANNEL_DO', class_name: 'ChannelDurableObject' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ChannelDurableObject'] }],
  vars: { PUBLIC_ORIGIN: 'https://sandbox.llll.gg', AGENT_MODEL: '@cf/test/model' },
}

describe('Worker Preview resources', () => {
  it('derives every resource from one validated PR number', () => {
    expect(previewResourceNames('42')).toEqual({
      prNumber: '42',
      previewName: 'pr-42',
      databaseName: 'llll-preview-pr-42-db',
      bucketName: 'llll-preview-pr-42-files',
      kvNamespace: 'llll-preview-pr-42-tickets',
    })
    expect(() => previewResourceNames('feature/login')).toThrow('positive integer')
    expect(() => previewResourceNames('0')).toThrow('positive integer')
  })

  it('extracts stable and immutable URLs from Wrangler JSON', () => {
    const output = {
      type: 'preview',
      preview_name: 'pr-42',
      preview_urls: ['https://pr-42.example.workers.dev'],
      deployment_id: 'deployment-1',
      deployment_urls: ['https://deployment-1.example.workers.dev'],
    }
    const deployment = previewDeployment(output)
    expect(deployment).toEqual({
      previewName: 'pr-42',
      previewUrl: 'https://pr-42.example.workers.dev',
      deploymentUrl: 'https://deployment-1.example.workers.dev',
      deploymentId: 'deployment-1',
    })
    expect(previewComment(deployment, 'abc123')).toContain('Exact deployment: https://deployment-1.example.workers.dev')
    expect(wranglerPreviewOutput(`${JSON.stringify({ type: 'wrangler-session' })}\n${JSON.stringify(output)}\n`)).toEqual(output)
    expect(() => previewDeployment({ type: 'preview', preview_urls: [], deployment_urls: [] })).toThrow('enable Preview')
  })

  it('binds Preview-safe resources without inheriting production data or origins', () => {
    const resources = previewResourceNames('42')
    const { preview, migrations } = buildPreviewConfigs(production, resources, {
      databaseId: 'preview-d1',
      kvNamespaceId: 'preview-kv',
    })

    expect(preview.previews).toMatchObject({
      vars: {
        AUTH_MODE: 'builtin',
        AUTH_REGISTRATION_MODE: 'invite_only',
        AGENT_MODEL: '@cf/test/model',
        LLLL_PREVIEW: 'pr-42',
      },
      ai: production.ai,
      browser: production.browser,
      d1_databases: [{ binding: 'DB', database_name: resources.databaseName, database_id: 'preview-d1' }],
      r2_buckets: [{ binding: 'FILES', bucket_name: resources.bucketName }],
      kv_namespaces: [{ binding: 'TICKETS', id: 'preview-kv' }],
      durable_objects: production.durable_objects,
    })
    expect(preview.assets).toEqual(production.assets)
    expect(preview.migrations).toEqual(production.migrations)
    expect(preview.previews).not.toHaveProperty('routes')
    expect(preview.previews).not.toHaveProperty('triggers')
    expect(preview.previews).not.toHaveProperty('secrets')
    expect(preview.previews.vars).not.toHaveProperty('ADMIN_EMAIL')
    expect(JSON.stringify(preview.previews)).not.toContain('production-d1')
    expect(JSON.stringify(preview.previews)).not.toContain('production-files')
    expect(JSON.stringify(preview.previews)).not.toContain('production-kv')
    expect(JSON.stringify(preview.previews)).not.toContain('sandbox.llll.gg')
    expect(migrations.d1_databases).toEqual([{
      binding: 'PREVIEW_DB',
      database_name: resources.databaseName,
      database_id: 'preview-d1',
      migrations_dir: 'drizzle/migrations',
    }])
  })
})
