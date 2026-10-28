// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import GitConnections from '../../app/components/settings/GitConnections.vue'
import SettingsList from '../../app/components/settings/SettingsList.vue'

const query = vi.hoisted(() => ({ useQuery: vi.fn(), useQueryClient: vi.fn() }))
vi.mock('@tanstack/vue-query', () => query)
const api = vi.fn(), refetch = vi.fn(), invalidateQueries = vi.fn(), toast = vi.fn()
const data = ref({ connections: [] as Array<{ id: string }>, canConfigure: true })
let wrapper: ReturnType<typeof mount> | undefined
const Button = defineComponent({
  props: ['label', 'disabled', 'type'],
  setup: props => () => h('button', { type: props.type || 'button', disabled: props.disabled }, props.label),
})
const Input = defineComponent({
  props: ['modelValue'], emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }),
})
beforeEach(() => {
  vi.clearAllMocks()
  data.value = { connections: [], canConfigure: true }
  refetch.mockResolvedValue({ error: null })
  query.useQuery.mockReturnValue({ data, error: ref(null), isPending: ref(false), refetch })
  query.useQueryClient.mockReturnValue({ invalidateQueries })
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('useToast', () => ({ add: toast }))
  vi.stubGlobal('errorMessage', (error: Error) => error.message)
  for (const [name, fn] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, fn)
  api.mockImplementation(async () => ({ actionUrl: 'https://github.com/settings/apps/new?state=' + api.mock.calls.length, manifest: { name: 'QA', redirect_url: 'https://server.example/callback' } }))
})
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })
async function prepare() {
  wrapper = mount(GitConnections, { global: { components: { SettingsList }, stubs: { UButton: Button, UInput: Input, UIcon: true, UCheckbox: true, UModal: { template: '<div><slot name="body" /></div>' }, UFormField: { template: '<label><slot /></label>' }, UBadge: true, LayoutLoadError: true } } })
  await wrapper.findAll('input')[1]!.setValue('qa-user')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  return wrapper
}
it('recovers a lost GitHub manifest POST with fresh state after sign-in', async () => {
  const view = await prepare()
  expect(view.text()).toContain('did not find an App Manifest')
  expect(view.findAll('form')[1]!.attributes('action')).toContain('state=1')
  await view.findAll('form')[1]!.trigger('submit')
  expect(view.findAll('button').find(button => button.text() === 'Create App on GitHub')!.attributes('disabled')).toBeDefined()
  await view.findAll('button').find(button => button.text() === 'Prepare again after GitHub sign-in')!.trigger('click')
  await flushPromises()
  expect(refetch).toHaveBeenCalledOnce()
  expect(api).toHaveBeenCalledTimes(2)
  expect(view.findAll('form')[1]!.attributes('action')).toContain('state=2')
  expect(view.findAll('button').find(button => button.text() === 'Create App on GitHub')!.attributes('disabled')).toBeUndefined()
})
it('discovers a completed connection before offering another App registration', async () => {
  const view = await prepare()
  refetch.mockImplementationOnce(async () => { data.value.connections.push({ id: 'created-during-github-redirect' }); return { error: null } })
  await view.findAll('button').find(button => button.text() === 'Prepare again after GitHub sign-in')!.trigger('click')
  await flushPromises()
  expect(api).toHaveBeenCalledOnce()
  expect(view.find('input[name="manifest"]').exists()).toBe(false)
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['code-environments'] })
})
it('does not create a new request when recovery cannot check existing connections', async () => {
  const view = await prepare()
  refetch.mockResolvedValueOnce({ error: new Error('Connection check unavailable') })
  await view.findAll('button').find(button => button.text() === 'Prepare again after GitHub sign-in')!.trigger('click')
  await flushPromises()
  expect(api).toHaveBeenCalledOnce()
  expect(toast).toHaveBeenCalledWith({ title: 'Connection check unavailable', color: 'error' })
})
