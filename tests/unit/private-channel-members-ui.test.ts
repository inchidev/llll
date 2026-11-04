// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import PrivateChannelMembers from '../../app/components/settings/PrivateChannelMembers.vue'

const alice = { id: 'alice-001', displayName: 'Alice', kind: 'human', avatarR2Key: null }
const bob = { id: 'bob-001', displayName: 'Bob', kind: 'human', avatarR2Key: null }
let members = [{ user: alice, status: 'active' }]
let failRemoval = false
const notify = vi.fn()
const api = vi.fn(async (path: string, options?: { method: string; body?: { userId: string } }) => {
  if (path.includes('/servers/')) return { members: [{ user: alice }, { user: bob }] }
  if (options?.method === 'POST') members = [...members, { user: bob, status: 'active' }]
  if (options?.method === 'DELETE') {
    if (failRemoval) throw new Error('Access changed')
    members = members.filter(member => member.user.id !== bob.id)
  }
  return { members }
})
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const views: ReturnType<typeof mount>[] = []
beforeEach(() => {
  members = [{ user: alice, status: 'active' }]; failRemoval = false; api.mockClear(); notify.mockClear()
  for (const [name, value] of Object.entries({ ref, computed, watch, useApi: () => ({ api }), useSessionStore: () => ({ user: alice }), useToast: () => ({ add: notify }), errorMessage: (error: Error) => error.message })) vi.stubGlobal(name, value)
})
afterEach(() => { views.splice(0).forEach(view => view.unmount()); cache.clear(); vi.unstubAllGlobals() })
const Button = defineComponent({ props: ['label', 'disabled', 'loading'], setup: (props, { attrs }) => () => h('button', { ...attrs, disabled: props.disabled || props.loading }, props.label) })
const Modal = defineComponent({ props: ['open', 'title', 'description'], setup: (props, { slots }) => () => props.open ? h('section', { role: 'dialog' }, [h('h2', props.title), h('p', props.description), slots.body?.(), slots.footer?.()]) : null })
function render() {
  const view = mount(PrivateChannelMembers, { props: { serverId: 'server-001', channel: { id: 'secret-001', name: 'secret' }, open: true }, global: {
    plugins: [[VueQueryPlugin, { queryClient: cache }]], stubs: { UButton: Button, UModal: Modal, UFormField: { template: '<div><slot /></div>' }, UInput: true, UserAvatar: true, LayoutLoadError: true },
  } })
  views.push(view)
  return view
}
it('adds through the private channel endpoint, then confirms removal before revoking access', async () => {
  const view = render(); await flushPromises()
  expect(view.find('[aria-label="Remove Alice"]').exists()).toBe(false)
  await view.get('[aria-label="Add Bob"]').trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/channels/secret-001/members', { method: 'POST', body: { userId: 'bob-001' } })
  await view.get('[aria-label="Remove Bob"]').trigger('click'); await flushPromises()
  expect(api.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false)
  expect(view.text()).toContain('They will lose access')
  await view.findAll('button').find(button => button.text() === 'Remove member')!.trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/channels/secret-001/members/bob-001', { method: 'DELETE' })
  expect(view.find('[aria-label="Remove Bob"]').exists()).toBe(false)
})
it('retains membership and reports an API denial instead of claiming successful removal', async () => {
  members = [...members, { user: bob, status: 'active' }]; failRemoval = true
  const view = render(); await flushPromises()
  await view.get('[aria-label="Remove Bob"]').trigger('click'); await flushPromises()
  await view.findAll('button').find(button => button.text() === 'Remove member')!.trigger('click'); await flushPromises()
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not update channel members', color: 'error' }))
  expect(view.find('[aria-label="Remove Bob"]').exists()).toBe(true)
})
