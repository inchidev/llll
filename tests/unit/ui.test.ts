import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isLastChannel, lastChannelSerializer, useUiStore } from '../../app/stores/ui'
import { isSearchShortcut } from '../../shared/shortcuts'

beforeEach(() => {
  vi.stubGlobal('useInstances', () => ({ scope: ref('https://test.example/server/test-user') }))
  vi.stubGlobal('useSessionStore', () => ({ user: { id: 'test-user' } }))
})

describe('keyboard shortcuts', () => {
  it('ignores key-like events without a string key', () => {
    expect(isSearchShortcut({ metaKey: true })).toBe(false)
    expect(isSearchShortcut({ key: 'K', metaKey: true })).toBe(true)
    expect(isSearchShortcut({ key: 'k', ctrlKey: true })).toBe(true)
  })
})

describe('last channel persistence', () => {
  it('rejects stale undefined route values', () => {
    expect(isLastChannel({ workspaceId: 'main', channelId: 'undefined' })).toBe(false)
    expect(isLastChannel({ workspaceId: 'undefined', channelId: 'channel-1' })).toBe(false)
    expect(isLastChannel({ workspaceId: 'main', channelId: 'channel-1' })).toBe(true)
  })

  it('round-trips through storage as JSON', () => {
    const last = { workspaceId: 'main', channelId: 'channel-1' }
    expect(lastChannelSerializer.read(lastChannelSerializer.write(last))).toEqual(last)
  })

  it('reads the old String() value and other junk as nothing remembered', () => {
    expect(lastChannelSerializer.read('[object Object]')).toBeNull()
    expect(lastChannelSerializer.read('null')).toBeNull()
    expect(lastChannelSerializer.read('{"workspaceId":"main","channelId":"undefined"}')).toBeNull()
  })
})

describe('composer state', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('keeps channel and thread drafts independent', () => {
    const ui = useUiStore()

    ui.setComposerDraft('channel-1', 'channel draft')
    ui.setComposerDraft('thread-1', 'thread draft')

    expect(ui.composerState('channel-1').draft).toBe('channel draft')
    expect(ui.composerState('thread-1').draft).toBe('thread draft')
  })

  it('scopes reply and edit targets to their composer', () => {
    const ui = useUiStore()

    ui.startReply('channel-1', 'message-1')
    ui.startEditing('thread-1', 'message-2', 'edit me')

    expect(ui.composerState('channel-1')).toMatchObject({
      draft: '',
      replyToId: 'message-1',
      editingId: null,
    })
    expect(ui.composerState('thread-1')).toMatchObject({
      draft: '',
      replyToId: null,
      editingId: 'message-2',
      editDraft: 'edit me',
    })
  })

  it('edits in place without touching the unsent draft or reply', () => {
    const ui = useUiStore()

    ui.setComposerDraft('channel-1', 'half-written thought')
    ui.startReply('channel-1', 'message-1')
    ui.startEditing('channel-1', 'message-2', 'old text')
    ui.setEditDraft('channel-1', 'new text')

    expect(ui.composerState('channel-1')).toMatchObject({
      draft: 'half-written thought',
      replyToId: 'message-1',
      editingId: 'message-2',
      editDraft: 'new text',
    })
  })

  it('closes an edit before a reply on Escape', () => {
    const ui = useUiStore()

    ui.startReply('channel-1', 'message-1')
    ui.startEditing('channel-1', 'message-2', 'text')
    ui.cancelComposerIntent('channel-1')
    expect(ui.composerState('channel-1')).toMatchObject({ editingId: null, replyToId: 'message-1' })

    ui.cancelComposerIntent('channel-1')
    expect(ui.composerState('channel-1').replyToId).toBeNull()
  })

  it('keeps an edit in progress when a message is sent', () => {
    const ui = useUiStore()

    ui.setComposerDraft('channel-1', 'sent')
    ui.startEditing('channel-1', 'message-2', 'text')
    ui.clearComposer('channel-1')

    expect(ui.composerState('channel-1')).toMatchObject({ draft: '', editingId: 'message-2' })
  })
})

describe('layout defaults', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts the right panel at a comfortable width', () => {
    expect(useUiStore().rightPanelWidth).toBe(280)
  })
})
