<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { DataBookmarkTargetType, DataResourcesDTO } from '~~/shared/types'

const props = defineProps<{
  workspaceId: string
  targetType: DataBookmarkTargetType
  targetId: string
}>()

const { api } = useApi()
const qc = useQueryClient()
const toast = useToast()
const saving = ref(false)
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', props.workspaceId]),
  queryFn: () => api<DataResourcesDTO>(`/api/workspaces/${props.workspaceId}/data-resources`),
  enabled: computed(() => Boolean(props.workspaceId && props.targetId)),
})
const bookmarked = computed(() => resourcesQ.data.value?.bookmarks.some(bookmark => bookmark.targetType === props.targetType && bookmark.targetId === props.targetId) ?? false)

async function toggle() {
  if (saving.value) return
  saving.value = true
  try {
    if (bookmarked.value) {
      await api(`/api/data-bookmarks/${props.targetType}/${encodeURIComponent(props.targetId)}`, { method: 'DELETE' })
    }
    else {
      await api('/api/data-bookmarks', { method: 'POST', body: { targetType: props.targetType, targetId: props.targetId } })
    }
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}
</script>

<template>
  <UTooltip :text="bookmarked ? 'Remove bookmark' : 'Bookmark'">
    <UButton
      color="neutral"
      variant="ghost"
      :icon="bookmarked ? 'i-ph-star-fill' : 'i-ph-star'"
      :aria-label="bookmarked ? 'Remove bookmark' : 'Bookmark'"
      :aria-pressed="bookmarked"
      :loading="saving"
      @click="toggle"
    />
  </UTooltip>
</template>
