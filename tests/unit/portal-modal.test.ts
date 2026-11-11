// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import PortalModal from '../../app/components/live/PortalModal.client.vue'

const opened = {
  portalId: '0194f3a2-7c1d-7e2f-8a3b-4c5d6e7f8091',
  url: 'https://team.example.com/portal/0194f3a2-7c1d-7e2f-8a3b-4c5d6e7f8091',
  guestUrl: 'https://team.example.com/portal/0194f3a2-7c1d-7e2f-8a3b-4c5d6e7f8091#t=guest',
  hostLink: 'partyportal://portal?url=https%3A%2F%2Fteam.example.com%2Fportal%2F0194f3a2-7c1d-7e2f-8a3b-4c5d6e7f8091&key=host&t=guest',
  expiresAt: '2026-11-13T00:00:00.000Z',
}

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach(view => view.unmount())
  delete window.__LLLL_NATIVE_PORTAL__
  vi.unstubAllGlobals()
})

async function render() {
  for (const [name, value] of Object.entries({ ref, watch, useApi: () => ({ api: vi.fn(async () => opened) }), useToast: () => ({ add: vi.fn() }) })) vi.stubGlobal(name, value)
  const view = mount(PortalModal, {
    props: { channelId: 'chat', open: false },
    global: { stubs: {
      UModal: { template: '<div><slot name="body"/><slot name="footer"/></div>' },
      UInput: true,
      UButton: { props: ['label', 'to', 'loading'], emits: ['click'], template: '<a v-if="to" :href="to">{{ label }}</a><button v-else @click="$emit(\'click\')">{{ label }}</button>' },
    } },
  })
  wrappers.push(view)
  await view.setProps({ open: true })
  await flushPromises()
  return view
}

const openButton = (view: ReturnType<typeof mount>) => view.findAll('a, button').find(element => element.text() === 'Open PartyPortal')!

it('stays a link to PartyPortal in a browser', async () => {
  const view = await render()
  expect(openButton(view).element.tagName).toBe('A')
  expect(openButton(view).attributes('href')).toBe(opened.hostLink)
})

it('asks the Mac app instead inside it, with the host link and nothing else', async () => {
  const share = vi.fn(async () => true)
  window.__LLLL_NATIVE_PORTAL__ = { share }
  const view = await render()
  expect(view.find(`a[href^="partyportal:"]`).exists()).toBe(false)
  await openButton(view).trigger('click')
  await flushPromises()
  expect(share).toHaveBeenCalledWith(opened.hostLink)
  expect(view.find('.text-error').exists()).toBe(false)
})

it('shows why the Mac app could not open PartyPortal', async () => {
  window.__LLLL_NATIVE_PORTAL__ = { share: vi.fn(async () => { throw 'Install PartyPortal for Mac to share a window.' }) }
  const view = await render()
  await openButton(view).trigger('click')
  await flushPromises()
  expect(view.find('.text-error').text()).toBe('Install PartyPortal for Mac to share a window.')
})

it('says nothing when the person declines in the app', async () => {
  window.__LLLL_NATIVE_PORTAL__ = { share: vi.fn(async () => false) }
  const view = await render()
  await openButton(view).trigger('click')
  await flushPromises()
  expect(view.find('.text-error').exists()).toBe(false)
})
