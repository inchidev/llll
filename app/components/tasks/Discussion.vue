<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { ClientMsg, MemberDTO } from '~~/shared/types'

/**
 * A task's conversation. It is an ordinary channel kept out of the navigation,
 * so it reuses the chat message list, composer, reactions, files, and realtime.
 * The channel is created the first time someone opens the task.
 */
const props = defineProps<{
  taskId: string
  channelId: string | null
  workspaceId: string
  members: MemberDTO[]
}>()

const { api } = useApi()
const qc = useQueryClient()
const ui = useUiStore()

const channelId = ref<string | null>(props.channelId)
const failed = ref(false)

async function ensureChannel() {
  if (channelId.value) return
  failed.value = false
  try {
    const res = await api<{ channelId: string }>(`/api/tasks/${props.taskId}/discussion`, { method: 'POST' })
    channelId.value = res.channelId
    void qc.invalidateQueries({ queryKey: ['task'] })
  }
  catch {
    failed.value = true
  }
}

watch(() => [props.taskId, props.channelId] as const, ([, id]) => {
  channelId.value = id
  void ensureChannel()
}, { immediate: true })

const { send, retry } = useChannelSocket(computed(() => channelId.value || ''))

function onReply(id: string) {
  if (channelId.value) ui.startReply(channelId.value, id)
}
</script>

<template>
  <section>
    <div class="mb-2 text-sm font-medium">Discussion</div>
    <LayoutLoadError v-if="failed" inline message="The discussion did not load." :retry="ensureChannel" />
    <div v-else class="flex h-[26rem] flex-col overflow-hidden rounded-lg border border-default">
      <LayoutSkeleton v-if="!channelId" variant="messages" :rows="3" class="flex-1" />
      <template v-else>
        <ChatMessageList
          :channel-id="channelId"
          :members="members"
          channel-name="this task"
          :show-intro="false"
          :allow-threads="false"
          @reply="onReply"
          @read="(messageId) => send({ t: 'read', messageId } as ClientMsg)"
          @retry="retry"
        />
        <ChatComposer
          :channel-id="channelId"
          :workspace-id="workspaceId"
          :members="members"
          :send="send as (msg: ClientMsg) => void"
          placeholder="Write about this task"
        />
      </template>
    </div>
  </section>
</template>
