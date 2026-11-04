<script setup lang="ts">
import type { ChatNotificationLevel } from '~~/shared/chat-attention'
const props = defineProps<{ channelId: string; thread?: boolean; dm?: boolean }>()
const { query, update } = useChatAttention(() => props.channelId)
const options = computed<Array<{ value: ChatNotificationLevel; label: string; description: string }>>(() => [
  { value: 'default', label: 'Default', description: props.dm ? 'Direct messages, mentions and followed threads' : 'Mentions and followed threads' },
  { value: 'all', label: 'All messages', description: 'Channel messages, mentions and followed threads' },
  { value: 'mentions', label: 'Mentions only', description: 'Only messages that mention you' },
  { value: 'muted', label: 'Off', description: 'No message alerts; unread messages stay in Inbox' },
])
</script>

<template>
  <UTooltip v-if="thread" :text="query.data.value?.following ? 'Stop following this thread' : 'Follow new replies in My threads'">
    <UButton :icon="query.data.value?.following ? 'i-ph-bell-ringing' : 'i-ph-bell'" :label="query.data.value?.following ? 'Following' : 'Follow'" size="xs" color="neutral" variant="ghost"
      :aria-pressed="Boolean(query.data.value?.following)" :disabled="!query.data.value" :loading="update.isPending.value"
      @click="update.mutate({ following: !query.data.value?.following })" />
  </UTooltip>
  <UPopover v-else>
    <UTooltip text="Message notifications">
      <UButton :icon="query.data.value?.notifications === 'muted' ? 'i-ph-bell-slash' : 'i-ph-bell'" aria-label="Message notifications" size="sm" color="neutral" variant="ghost" />
    </UTooltip>
    <template #content>
      <div class="w-72 p-2">
        <p class="px-2 py-2 text-sm font-semibold">Message notifications</p>
        <LayoutLoadError v-if="query.error.value" inline message="Settings did not load." :retry="query.refetch" />
        <button v-for="option in options" :key="option.value" type="button" class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-start hover:bg-elevated disabled:opacity-50"
          :aria-pressed="query.data.value?.notifications === option.value" :disabled="!query.data.value || update.isPending.value" @click="update.mutate({ notifications: option.value })">
          <span class="min-w-0 flex-1"><span class="block text-sm font-medium">{{ option.label }}</span><span class="block text-xs text-muted">{{ option.description }}</span></span>
          <UIcon v-if="query.data.value?.notifications === option.value" name="i-ph-check" class="size-4 text-primary" />
        </button>
      </div>
    </template>
  </UPopover>
</template>
