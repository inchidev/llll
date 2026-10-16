<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelFileDTO } from '~~/shared/types'
import AttachmentGallery from './AttachmentGallery.vue'

const props = defineProps<{
  channelId: string
}>()
const { api } = useApi()

const filesQ = useQuery({
  queryKey: computed(() => ['files', props.channelId]),
  queryFn: () => api<{ files: ChannelFileDTO[] }>(`/api/channels/${props.channelId}/files`),
  enabled: computed(() => Boolean(props.channelId)),
})
</script>

<template>
  <div v-if="filesQ.isPending.value" class="p-3">
    <LayoutSkeleton variant="cards" />
  </div>
  <LayoutLoadError v-else-if="filesQ.error.value" message="Files did not load." :retry="filesQ.refetch" />
  <div v-else-if="!filesQ.data.value?.files.length" class="px-4 py-10 text-center">
    <UIcon name="i-ph-paperclip" class="size-6 text-dimmed" />
    <p class="mt-2 text-sm font-medium text-highlighted">No files yet</p>
    <p class="mt-1 text-xs text-muted">Files shared in this conversation collect here.</p>
  </div>
  <div v-else class="px-3 pb-3">
    <AttachmentGallery :attachments="filesQ.data.value?.files ?? []" />
  </div>
</template>
