// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Avatar from '../../packages/client-ui/ServerAvatar.vue'

it('falls back on a missing image and retries after its version changes, then removes it', async () => {
  const view = mount(Avatar, { props: { name: 'New community', iconUrl: 'https://fixture.example/.well-known/llll/icon?v=1' } })
  expect(view.get('img').attributes('crossorigin')).toBe('anonymous')
  expect(view.get('img').attributes('referrerpolicy')).toBe('no-referrer')
  await view.get('img').trigger('error')
  expect(view.text()).toBe('NC')
  await view.setProps({ iconUrl: 'https://fixture.example/.well-known/llll/icon?v=2' })
  expect(view.get('img').attributes('src')).toContain('v=2')
  await view.setProps({ name: 'Another name', iconUrl: null })
  expect(view.find('img').exists()).toBe(false)
  expect(view.text()).toBe('AN')
  view.unmount()
})
