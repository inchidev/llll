// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import MessageItem from '../../app/components/chat/MessageItem.vue'
import type { MessageDTO } from '../../shared/types'

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); vi.unstubAllGlobals() })

it('keeps message actions selectable after the pointer leaves the row for the open menu', async () => {
  for (const [name, value] of Object.entries({
    computed, ref, shallowRef, watch, onBeforeUnmount,
    usePrefsStore: () => ({ recentEmoji: [] }),
    useUiStore: () => ({}), useShiftHeld: () => ref(false),
  })) vi.stubGlobal(name, value)
  const selected = vi.fn()
  const actions = [[{ label: 'Mark unread from here', onSelect: selected }]]
  const Menu = defineComponent({
    props: ['open', 'items'], emits: ['update:open'],
    template: `<div><button @click="$emit('update:open', !open)">More</button>
      <button v-if="open" role="menuitem" @click="items[0][0].onSelect()">{{ items[0][0].label }}</button></div>`,
  })
  const message: MessageDTO = {
    id: 'message', channelId: 'channel', serverId: 'server',
    author: { id: 'human', kind: 'human', displayName: 'Member', avatarR2Key: null },
    content: 'Read this later', threadId: null, replyTo: null, mentions: [], attachments: [], reactions: [], pin: null,
    editedAt: null, deletedAt: null, createdAt: '2026-11-04T12:00:00Z',
  }
  view = mount(MessageItem, { props: { message, names: {}, mine: false, active: true, actions }, global: { stubs: {
    UDropdownMenu: Menu, UPopover: true, UTooltip: true, UButton: true, UIcon: true, USeparator: true,
    ChatMarkdown: true, ChatMessageBody: true, ChatEmojiPicker: true, AttachmentGallery: true,
  } } })
  await view.getComponent(Menu).get('button').trigger('click')
  await view.setProps({ active: false, actions: undefined })
  await view.get('[role="menuitem"]').trigger('click')
  expect(selected).toHaveBeenCalledOnce()
  view.getComponent(Menu).vm.$emit('update:open', false)
  await view.vm.$nextTick()
  expect(view.find('[role="toolbar"]').exists()).toBe(false)
})
