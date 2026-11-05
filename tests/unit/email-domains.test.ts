// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EmailDomains from '../../app/components/settings/EmailDomains.vue'

const mail = { configured: true, sendingBound: false, domains: [{ id: 'mail-domain', domain: 'example.com', appHostname: 'chat.example.com' }], mailboxes: [] }
const Button = { props: ['label'], template: '<button>{{ label }}</button>' }
const zone = { id: 'zone', name: 'example.com' }
function render(isOwner: boolean, direct: boolean, domains: Record<string, unknown> = { zones: [zone] }) {
  const api = vi.fn(async (_url: string, options?: { method?: string }) => options?.method === 'POST' ? { id: 'new-domain', domain: 'example.com' } : { direct, ...domains })
  for (const [name, value] of Object.entries({ computed, ref, watch, useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), errorMessage: String })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(EmailDomains, { props: { serverId: 'server', isOwner, mail }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: { UIcon: true, UButton: Button, UFormField: { template: '<div><slot /></div>' }, USelect: true, UInput: true } } })
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
  it('points the owner to Cloudflare when the account has no active domain', async () => {
    const view = render(true, true, { zones: [] })
    await flushPromises()
    expect(view.text()).toContain('This Cloudflare account has no active domain')
    expect(view.findAll('button').map(button => button.text())).toEqual(['Open Cloudflare domains', 'Disconnect'])
    view.unmount()
  })
  it('offers to finish a domain that receives mail but cannot send', async () => {
    const view = render(true, true, { zones: [zone], emailDomains: [{ id: 'mail-domain', zoneId: 'zone', domain: 'example.com', zoneName: 'example.com', sendingEnabled: false }] })
    await flushPromises()
    expect(view.text()).toContain('Receives mail, sending is off')
    expect(view.findAll('button').map(button => button.text())).toContain('Finish connecting')
    view.unmount()
  })
  it('moves on to the first mailbox after connecting a domain', async () => {
    const view = render(true, true)
    await flushPromises()
    await view.findAll('button').find(button => button.text() === 'Connect domain')!.trigger('click')
    await flushPromises()
    await view.find('form').trigger('submit')
    await flushPromises()
    expect(view.emitted('connected')).toEqual([['new-domain']])
    view.unmount()
  })
  it('lets the owner connect and disconnect domains once the Server keeps Cloudflare access', async () => {
    const view = render(true, true)
    await flushPromises()
    expect(view.findAll('button').map(button => button.text())).toEqual(['Connect domain', 'Disconnect'])
    view.unmount()
  })
})
