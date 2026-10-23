// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EmailDomains from '../../app/components/settings/EmailDomains.vue'

describe('configured mail domains', () => {
  it.each([true, false])('shows configured domains for owner=%s without offering unsupported domain mutations', (isOwner) => {
    const view = mount(EmailDomains, { props: { serverId: 'server', isOwner, mail: {
      configured: true, sendingBound: false, domains: [{ id: 'mail-domain', domain: 'example.com', appHostname: 'chat.example.com' }], mailboxes: [],
    } }, global: { stubs: { UIcon: true } } })
    expect(view.text()).toContain('example.com')
    expect(view.text()).not.toContain('No email domains yet')
    expect(view.findAll('button')).toHaveLength(0)
    view.unmount()
  })
})
