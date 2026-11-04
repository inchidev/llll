// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/') })
it('captures a direct claim before navigation even when session storage is blocked', async () => {
  const claim = ref(''), token = 'synthetic-private-owner-claim-'.padEnd(64, 'x')
  history.replaceState(null, '', '/setup#claim=' + token)
  vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
  vi.stubGlobal('useState', () => claim)
  vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
  const plugin = (await import('../../app/plugins/00-owner-claim.client')).default as unknown as { order: number; setup: () => void }
  expect(plugin.order).toBeLessThan(0)
  plugin.setup()
  expect(claim.value).toBe(token)
  expect(location.hash).toBe('')
  history.replaceState(null, '', '/setup?parent=https://llll.gg')
  expect(claim.value).toBe(token)
})
