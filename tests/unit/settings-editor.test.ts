// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, inject, nextTick, onBeforeUnmount, provide, ref, shallowRef, watchEffect } from 'vue'
import { mount } from '@vue/test-utils'
import SettingsEditor from '../../app/components/settings/SettingsEditor.vue'
import SettingsHeader from '../../app/components/settings/SettingsHeader.vue'
import { settingsDetailBackKey } from '../../app/composables/useSettingsDetailBack'
import { settingsEditorKey } from '../../app/composables/useSettingsEditor'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('replaces the list with an editor and retains back navigation when editors change', async () => {
  for (const [name, value] of Object.entries({ inject, watchEffect, onBeforeUnmount, settingsDetailBackKey })) vi.stubGlobal(name, value)
  const first = ref(false)
  const second = ref(false)
  const active = shallowRef<symbol | null>(null)
  const back = shallowRef<{ label: string; go: () => void } | null>(null)
  const Host = defineComponent({
    setup() {
      const target = ref<HTMLElement | null>(null)
      provide(settingsEditorKey, { target, active })
      provide(settingsDetailBackKey, back)
      const page = (open: typeof first, title: string) => h(SettingsEditor, { open: open.value, 'onUpdate:open': (value: boolean) => { open.value = value }, title, back: 'List' }, { body: () => h('p', `${title} form`) })
      return () => h('div', [h('div', { style: { display: active.value ? 'none' : '' } }, [h('p', 'List of items'), page(first, 'First'), page(second, 'Second')]), h('div', { ref: target })])
    },
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { components: { SettingsHeader }, stubs: { UIcon: true } } })
  first.value = true
  await nextTick()
  expect(document.body.textContent).toContain('First form')
  expect(back.value?.label).toBe('List')
  second.value = true
  first.value = false
  await nextTick()
  expect(document.body.textContent).toContain('Second form')
  expect(back.value?.label).toBe('List')
  back.value?.go()
  await nextTick()
  expect(active.value).toBeNull()
  expect(document.body.textContent).not.toContain('Second form')
  expect(wrapper.text()).toContain('List of items')
  wrapper.unmount()
})
