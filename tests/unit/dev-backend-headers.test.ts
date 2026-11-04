import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNitro } from 'nitropack'
import { describe, expect, it } from 'vitest'
import { createWatchHeadersPlugin } from '../../scripts/watch-headers.mjs'

describe('watched backend headers', () => {
  it.each([undefined, '/custom/*\n  X-Custom: preserved\n'])('regenerates current rules without accumulating previous builds (%s)', async (original) => {
    const root = await mkdtemp(join(tmpdir(), 'llll-watch-headers-'))
    const nitro = await createNitro({
      rootDir: root, dev: false, preset: 'cloudflare-module', compatibilityDate: '2026-10-22',
      logLevel: 0, cloudflare: { deployConfig: false },
      routeRules: { '/**': { headers: { 'X-Test': 'first' } }, '/assets/**': { headers: { 'Cache-Control': 'immutable' } } },
    })
    const headers = join(nitro.options.output.publicDir, '_headers')
    try {
      await mkdir(nitro.options.output.publicDir, { recursive: true })
      if (original !== undefined) await writeFile(headers, original)
      const plugin = await createWatchHeadersPlugin(nitro.options.output.publicDir)
      await plugin.buildStart()
      await nitro.hooks.callHook('compiled', nitro)
      nitro.options.routeRules['/**']!.headers = { 'X-Test': 'second' }
      for (let i = 0; i < 3; i++) {
        await plugin.buildStart()
        await nitro.hooks.callHook('compiled', nitro)
      }
      const result = await readFile(headers, 'utf8')
      expect(result).not.toContain('X-Test: first')
      expect(result.match(/^\/\*$/gm)).toHaveLength(1)
      expect(result.match(/^\/assets\/\*$/gm)).toHaveLength(1)
      expect(result).toContain('X-Test: second')
      if (original) expect(result).toContain(original)
    } finally {
      await nitro.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
