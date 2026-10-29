// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EmailDomains from '../../app/components/settings/EmailDomains.vue'

const mail = { configured: true, sendingBound: false, domains: [{ id: 'mail-domain', domain: 'example.com', appHostname: 'chat.example.com' }], mailboxes: [] }
const Button = { props: ['label'], template: '<button>{{ label }}</button>' }
function render(isOwner: boolean, direct: boolean) {
  const api = vi.fn(async () => ({ direct, zones: [{ id: 'zone', name: 'example.com' }] }))
  for (const [name, value] of Object.entries({ computed, ref, watch, useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), errorMessage: String })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(EmailDomains, { props: { serverId: 'server', isOwner, mail }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: { UIcon: true, UButton: Button } } })
}
afterEach(() => vi.unstubAllGlobals())

describe('configured mail domains', () => {
  it.each([true, false])('shows configured domains for owner=%s and offers no changes without kept Cloudflare access', async (isOwner) => {
    const view = render(isOwner, false)
    await flushPromises()
    expect(view.text()).toContain('example.com')
    expect(view.text()).not.toContain('No email domains yet')
    expect(view.findAll('button')).toHaveLength(0)
    view.unmount()
  })
  it('lets the owner connect and disconnect domains once the Server keeps Cloudflare access', async () => {
    const view = render(true, true)
    await flushPromises()
    expect(view.findAll('button').map(button => button.text())).toEqual(['Connect domain', 'Disconnect'])
    view.unmount()
  })
})
