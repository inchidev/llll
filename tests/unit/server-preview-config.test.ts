import { expect, it } from 'vitest'
import { isolatedPreviewBindings, nativeServerPreviewOrigin } from '../../scripts/server-preview-config.mjs'

it('replaces template Preview bindings with the resources provisioned by the Git Build', () => {
  const config = {
    vars: { PUBLIC_ORIGIN: 'https://fixture.test', EMBED_ORIGINS: 'https://shell.test', LLLL_VERSION: '0.2.8' },
    d1_databases: [{ binding: 'DB', database_id: 'per-pr-database', database_name: 'llll-server-pr-241' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'staging-files' }, { binding: 'BACKUPS', bucket_name: 'staging-backups' }],
    kv_namespaces: [{ binding: 'TICKETS', id: 'staging-tickets' }],
    durable_objects: { bindings: [{ name: 'CHANNEL_DO', class_name: 'ChannelDurableObject' }] },
    previews: { vars: { PUBLIC_ORIGIN: 'template' }, d1_databases: [{ database_id: 'placeholder' }], kv_namespaces: [{ id: 'placeholder' }] },
  }
  const preview = isolatedPreviewBindings(config)
  expect(preview).toEqual({ vars: config.vars, d1_databases: config.d1_databases, r2_buckets: config.r2_buckets, kv_namespaces: config.kv_namespaces, durable_objects: config.durable_objects })
  expect(JSON.stringify(preview)).not.toContain('placeholder')
  expect(preview.r2_buckets[0].bucket_name).not.toBe(preview.r2_buckets[1].bucket_name)
})

it('uses the assigned custom Preview URL and rejects missing or foreign hosts', () => {
  expect(nativeServerPreviewOrigin({ urls: ['https://example.workers.dev', 'https://assigned-slug.server-preview.llll.gg'] })).toBe('https://assigned-slug.server-preview.llll.gg')
  expect(() => nativeServerPreviewOrigin({ urls: [] })).toThrow('shared custom Preview domain')
  expect(() => nativeServerPreviewOrigin({ urls: ['http://wrong.server-preview.llll.gg', 'https://server-preview.llll.gg.evil.test'] })).toThrow()
})
