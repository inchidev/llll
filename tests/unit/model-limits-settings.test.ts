// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
import ModelLimits from '../../app/components/settings/ModelLimits.vue'

Object.assign(globalThis, { computed, ref })
const stubs = {
  UButton: { props: ['label'], emits: ['click'], template: '<button @click="$emit(\'click\')">{{ label }}</button>' },
  UFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' },
  UInput: { props: ['modelValue', 'placeholder'], emits: ['update:modelValue'], template: '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
}

it('shows the limits a Run will use with their sources, and lets the Owner set only what the provider did not report', async () => {
  const view = mount(ModelLimits, { props: { reported: { contextWindow: 100_000 }, catalog: { maxOutputTokens: 16_000 }, editable: true, label: 'Private', modelValue: undefined }, global: { stubs } })
  expect(view.text()).toContain('Window 100,000 tokens, reported by the provider')
  expect(view.text()).toContain('Answer 16,000, from Pi’s catalog')
  await view.get('button').trigger('click')
  expect(view.findAll('input')).toHaveLength(1)
  expect(view.text()).toContain('Private: answer limit')
  await view.get('input').setValue('8000')
  expect(view.emitted('update:modelValue')!.at(-1)).toEqual([{ maxOutputTokens: 8000 }])
  await view.setProps({ modelValue: { maxOutputTokens: 8000 } })
  expect(view.text()).toContain('Answer 8,000, set by you')
  await view.get('input').setValue('')
  expect(view.emitted('update:modelValue')!.at(-1)).toEqual([undefined])
})

it('offers nothing to set when the provider reported both limits', () => {
  const view = mount(ModelLimits, { props: { reported: { contextWindow: 1_000_000, maxOutputTokens: 64_000 }, editable: true }, global: { stubs } })
  expect(view.text()).toContain('Window 200,000 tokens, reported by the provider · Answer 32,000, reported by the provider')
  expect(view.find('button').exists()).toBe(false)
})
