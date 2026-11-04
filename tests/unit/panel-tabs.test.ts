// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick, onMounted, ref, watch } from 'vue'
import { mount } from '@vue/test-utils'
import Tabs from '../../app/components/layout/SegmentedTabs.vue'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('moves keyboard focus and reveals each selected panel tab, including the last and first', async () => {
  for (const [name, fn] of Object.entries({ ref, watch, nextTick, onMounted })) vi.stubGlobal(name, fn)
  const scroll = vi.fn()
  const view = mount(Tabs, { attachTo: document.body, props: { modelValue: 'members', label: 'Right panel views', items: ['members', 'threads', 'pins', 'files'].map(value => ({ value, label: value })), 'onUpdate:modelValue': value => { void view.setProps({ modelValue: value }) } }, global: { stubs: { UIcon: true } } })
  const tabs = view.findAll('button')
  for (const tab of tabs) tab.element.scrollIntoView = scroll
  await tabs[0]!.trigger('keydown', { key: 'End' })
  await nextTick()
  expect(tabs[3]!.attributes('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tabs[3]!.element)
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  await tabs[3]!.trigger('keydown', { key: 'ArrowRight' })
  await nextTick()
  expect(tabs[0]!.attributes('tabindex')).toBe('0')
  expect(document.activeElement).toBe(tabs[0]!.element)
  view.unmount()
})
