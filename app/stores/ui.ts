import { defineStore } from 'pinia'
import { useSafeLocalStorage } from '../composables/useSafeLocalStorage'
import { ref } from 'vue'
import type { RightPanelTab } from '~~/shared/types'

type LastChannel = { serverId: string; channelId: string }

/** Marks `threadId` while a new thread is being created and has no id yet. */
export const PENDING_THREAD_PREFIX = 'pending:'

export function isLastChannel(value: unknown): value is LastChannel {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LastChannel>
  return Boolean(
    candidate.serverId
    && candidate.serverId !== 'undefined'
    && candidate.serverId !== 'null'
    && candidate.channelId
    && candidate.channelId !== 'undefined'
    && candidate.channelId !== 'null',
  )
}

/**
 * A null default makes VueUse store values with String(), which saved
 * "[object Object]" and lost the last channel. Store JSON explicitly, and read
 * anything unparseable (including that old value) as nothing remembered.
 */
export const lastChannelSerializer = {
  read(raw: string): LastChannel | null {
    try {
      const value: unknown = JSON.parse(raw)
      return isLastChannel(value) ? value : null
    }
    catch {
      return null
    }
  },
  write(value: LastChannel | null): string {
    return JSON.stringify(value)
  },
}

export const useUiStore = defineStore('ui', () => {
  const connection = useServers()
  const scope = `${connection.scope.value}/${useSessionStore().user?.id || 'anonymous'}`
  type ComposerState = {
    draft: string
    replyToId: string | null
    /** The message being edited in place, with its own draft so the composer keeps its text. */
    editingId: string | null
    editDraft: string
  }

  const rightPanelOpen = ref(true)
  const rightPanelTab = ref<RightPanelTab>('members')
  const mobilePane = ref<'channels' | 'chat' | 'members'>('chat')
  const composerStates = import.meta.client ? useSafeLocalStorage<Record<string, ComposerState>>(`llll:drafts:${scope}`, {}) : ref<Record<string, ComposerState>>({})
  const liveSetupOpen = ref(false)
  const threadId = ref<string | null>(null)
  const threadParentId = ref<string | null>(null)
  const pendingThreadTitle = ref('')
  const dmFrozen = ref(false)
  const searchQuery = ref('')
  const searchOpen = ref(false)
  /** The header search covers the open conversation or every conversation on the Server. */
  const searchScope = ref<'conversation' | 'server'>('conversation')
  const memberTab = ref<'all' | 'online'>('all')
  const channelPaneWidth = import.meta.client
    ? useSafeLocalStorage('df:channel-pane-width', 240)
    : ref(240)
  const rightPanelWidth = import.meta.client
    ? useSafeLocalStorage('df:right-panel-width', 280)
    : ref(280)
  const mailListWidth = import.meta.client
    ? useSafeLocalStorage('df:mail-list-width', 320)
    : ref(320)
  const navCollapsed = import.meta.client
    ? useSafeLocalStorage<Record<string, boolean>>(`llll:nav-collapsed:${scope}`, {})
    : ref<Record<string, boolean>>({})
  const lastChannel = import.meta.client
    ? useSafeLocalStorage<LastChannel | null>(`llll:last:${scope}`, null, { serializer: lastChannelSerializer })
    : ref<LastChannel | null>(null)

  function isCollapsed(key: string) {
    return Boolean(navCollapsed.value[key])
  }

  function setCollapsed(key: string, value: boolean) {
    navCollapsed.value = { ...navCollapsed.value, [key]: value }
  }

  function remember(serverId: string, channelId: string) {
    if (!serverId || serverId === 'undefined' || !channelId || channelId === 'undefined') return
    lastChannel.value = { serverId, channelId }
  }

  function last(): LastChannel | null {
    if (isLastChannel(lastChannel.value)) return lastChannel.value
    lastChannel.value = null
    return null
  }

  function composerState(channelId: string): ComposerState {
    return composerStates.value[channelId] ??= {
      draft: '',
      replyToId: null,
      editingId: null,
      editDraft: '',
    }
  }

  function setComposerDraft(channelId: string, draft: string) {
    composerState(channelId).draft = draft
  }

  function startReply(channelId: string, messageId: string) {
    composerState(channelId).replyToId = messageId
  }

  function startEditing(channelId: string, messageId: string, content: string) {
    const state = composerState(channelId)
    state.editingId = messageId
    state.editDraft = content
  }

  function setEditDraft(channelId: string, draft: string) {
    composerState(channelId).editDraft = draft
  }

  function cancelEditing(channelId: string) {
    const state = composerState(channelId)
    state.editingId = null
    state.editDraft = ''
  }

  /** Escape: an edit in progress closes first, then a pending reply. */
  function cancelComposerIntent(channelId: string) {
    const state = composerState(channelId)
    if (state.editingId) cancelEditing(channelId)
    else state.replyToId = null
  }

  function clearComposer(channelId: string) {
    const state = composerState(channelId)
    state.draft = ''
    state.replyToId = null
  }

  return {
    rightPanelOpen,
    rightPanelTab,
    mobilePane,
    liveSetupOpen,
    threadId,
    threadParentId,
    pendingThreadTitle,
    dmFrozen,
    searchQuery,
    searchOpen,
    searchScope,
    memberTab,
    channelPaneWidth,
    rightPanelWidth,
    mailListWidth,
    navCollapsed,
    isCollapsed,
    setCollapsed,
    remember,
    last,
    composerState,
    setComposerDraft,
    startReply,
    startEditing,
    setEditDraft,
    cancelEditing,
    cancelComposerIntent,
    clearComposer,
  }
})
