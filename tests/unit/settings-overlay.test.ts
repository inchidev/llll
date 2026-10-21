// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { defineShortcuts } from '../../node_modules/@nuxt/ui/dist/runtime/composables/defineShortcuts.js'
import SettingsOverlay from '../../app/components/settings/SettingsOverlay.vue'
import UpdateBanner from '../../app/components/client/UpdateBanner.vue'

// Use Nuxt UI's actual layer stack and Select primitives, without its theme/build aliases.
const { DialogRoot, DialogPortal, DialogContent, DialogTitle, DialogDescription, SelectRoot, SelectTrigger, SelectPortal, SelectContent, SelectViewport, SelectItem, SelectItemText } = createRequire(import.meta.resolve('@nuxt/ui'))('reka-ui')
const mounted: ReturnType<typeof mount>[] = []
const mobile = ref(false)
beforeEach(() => {
  mobile.value = false
  for (const [name, fn] of Object.entries({ ref, computed, watch, nextTick, defineShortcuts, useAppConfig: () => ({ version: '0.2.3' }), useIsMobile: () => mobile, provideSettingsDetailBack: () => ref(null), useRoute: () => ({ query: { section: 'updates' } }), useNuxtApp: () => ({ $pwa: { waiting: ref(true), updating: ref(false), error: ref(''), update: vi.fn(), check: vi.fn() } }) })) vi.stubGlobal(name, fn)
})
afterEach(() => { mounted.splice(0).forEach(v => v.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
const Button = defineComponent({ props: ['label'], setup: (p, { attrs }) => () => h('button', attrs, p.label) })
const Modal = defineComponent({ props: ['open', 'content'], emits: ['update:open'], setup: (p, { emit, slots }) => () => h(DialogRoot, { open: p.open, 'onUpdate:open': (value: boolean) => emit('update:open', value) }, () => h(DialogPortal, {}, () => h(DialogContent, {
  ...p.content,
  onEscapeKeyDown: (event: KeyboardEvent) => { p.content?.onEscapeKeyDown?.(event); event.preventDefault() },
  onInteractOutside: (event: Event) => event.preventDefault(),
}, () => [h(DialogTitle, {}, () => 'Settings'), h(DialogDescription, {}, () => 'Server settings'), slots.content?.()]))) })
function view(slot?: ReturnType<typeof defineComponent>) {
  const v = mount(SettingsOverlay, { attachTo: document.body, props: { open: true, section: 'updates', title: 'Server', groups: [{ items: [{ id: 'updates', label: 'Updates', icon: 'i-ph-arrow-up' }] }] }, slots: { default: slot || '<p>Update settings</p>' }, global: { stubs: { UModal: Modal, UInput: true, UIcon: true, UBadge: true, USeparator: true, UButton: Button, LayoutSkeleton: true, ClientUpdateBanner: UpdateBanner } } })
  mounted.push(v)
  return v
}
it('offers a waiting Client update inside fullscreen settings', async () => {
  view(); await flushPromises()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('An L4 update is ready')
  expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Update now')).toBe(true)
})
it.each([false, true])('Escape dismisses only the release list, then settings (mobile=%s)', async (isMobile) => {
  mobile.value = isMobile
  const ReleaseSelect = defineComponent({ setup: () => () => h(SelectRoot, { defaultOpen: true, defaultValue: 'v0.2.4' }, { default: () => [h(SelectTrigger, {}, () => 'Release'), h(SelectPortal, {}, () => h(SelectContent, { position: 'popper' }, () => h(SelectViewport, {}, () => h(SelectItem, { value: 'v0.2.4' }, () => h(SelectItemText, {}, () => 'v0.2.4')))))] }) })
  const v = view(ReleaseSelect); await flushPromises()
  const list = document.querySelector('[role="listbox"]')!
  expect(list).not.toBeNull()
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  await flushPromises()
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(v.emitted('update:open')).toBeUndefined()
  document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  await nextTick()
  if (isMobile) {
    expect(v.emitted('update:open')).toBeUndefined()
    expect([...document.querySelectorAll('nav button')].find(b => b.textContent?.includes('Updates'))?.closest('div.hidden')).toBeNull()
    document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
  }
  expect(v.emitted('update:open')).toEqual([[false]])
})
