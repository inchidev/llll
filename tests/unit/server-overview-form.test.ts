// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { mount } from '@vue/test-utils'
import Form from '../../app/components/settings/ServerOverviewForm.vue'
import SaveBar from '../../app/components/layout/SaveBar.vue'

const Input = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], setup: (props, { emit }) => () => h('input', { value: props.modelValue, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value) }) })
const Button = defineComponent({ props: ['label', 'disabled'], setup: (props, { attrs }) => () => h('button', { ...attrs, type: 'button', disabled: props.disabled }, props.label) })
const ValidatedForm = defineComponent({
  props: ['state', 'schema'], emits: ['submit'],
  setup(props, { emit, expose, slots }) {
    expose({ clear: vi.fn(), submit: () => { const parsed = props.schema.safeParse(props.state); if (parsed.success) emit('submit', { data: parsed.data }) } })
    return () => h('form', slots.default?.())
  },
})
beforeEach(() => { for (const [name, fn] of Object.entries({ ref, reactive, computed, watch })) vi.stubGlobal(name, fn) })
afterEach(() => { vi.unstubAllGlobals() })
it('only offers saving for a valid changed name, preserves drafts on refresh and resets to the latest saved name', async () => {
  const view = mount(Form, { props: { name: 'abra cadabra', editable: true, saving: false }, global: { stubs: { UForm: ValidatedForm, UFormField: { template: '<label>Server name<slot /></label>' }, UInput: Input, LayoutSaveBar: SaveBar, UButton: Button } } })
  expect(view.find('[role="status"]').exists()).toBe(false)
  await view.get('input').setValue('New name')
  expect(view.get('form').attributes('data-update-blocked')).toBe('true')
  await view.setProps({ name: 'Remote name' })
  expect(view.get('input').element.value).toBe('New name')
  await view.findAll('button')[0]!.trigger('click')
  expect(view.get('input').element.value).toBe('Remote name')
  expect(view.find('[role="status"]').exists()).toBe(false)
  await view.get('input').setValue('   ')
  expect(view.findAll('button')[1]!.attributes('disabled')).toBeDefined()
  await view.get('input').setValue('Changed name')
  await view.findAll('button')[1]!.trigger('click')
  expect(view.emitted('save')).toEqual([['Changed name']])
  await view.setProps({ name: 'Changed name' })
  expect(view.find('[role="status"]').exists()).toBe(false)
  view.unmount()
})
