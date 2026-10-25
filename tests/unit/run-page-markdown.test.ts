// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import RunPage from '../../app/pages/runs/[id].vue'
import MarkdownView from '../../app/components/chat/MarkdownView.vue'
afterEach(() => vi.unstubAllGlobals())
it('formats saved Agent results and source links while keeping untrusted HTML inert', async () => {
  const resultText = '**Verified fact:** SQLite is supported.\n\n- Read-only evidence\n\n[Source](https://developers.cloudflare.com/durable-objects/)\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert(1))'
  const api = vi.fn(async () => ({ run: { status: 'completed', resultText, createdAt: '2026-10-25', modelCalls: 0 }, canCancel: false }))
  for (const [name, value] of Object.entries({ computed, ref, definePageMeta: () => {}, useRoute: () => ({ params: { id: 'run' } }), useApi: () => ({ api }), useRoleGrants: () => ({ can: () => false }), useToast: () => ({ add: vi.fn() }) })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(RunPage, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { ChatMarkdownView: MarkdownView }, stubs: { LayoutPageHeader: true, LayoutSkeleton: true, LayoutLoadError: true, UBadge: true, UButton: true, UAlert: true } } })
  try {
    await flushPromises()
    expect(view.get('strong').text()).toBe('Verified fact:')
    expect(view.get('.md li').text()).toBe('Read-only evidence')
    const link = view.get('.md a')
    expect(link.attributes('href')).toBe('https://developers.cloudflare.com/durable-objects/')
    expect(link.attributes('rel')).toContain('noopener')
    expect(view.find('script').exists()).toBe(false)
    expect(view.find('a[href^="javascript:"]').exists()).toBe(false)
    expect(view.text()).toContain('<script>alert(1)</script>')
    expect(view.text()).not.toContain('**Verified fact:**')
  } finally { view.unmount(); client.clear() }
})
