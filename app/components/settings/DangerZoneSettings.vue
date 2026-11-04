<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ServerDeletionStatusDTO } from '~~/shared/deletion'
const { api } = useApi()
const props = defineProps<{ serverId: string, serverName: string }>()
defineEmits<{ backups: [] }>()
const deletionQ = useQuery({
  queryKey: computed(() => ['server-deletion', props.serverId]),
  queryFn: () => api<ServerDeletionStatusDTO>(`/api/servers/${props.serverId}/deletion`),
})
</script>
<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Remove server</h1>
    <p class="mt-1 text-sm text-muted">Back up {{ serverName }} before removing its deployment.</p>
    <LayoutSkeleton v-if="deletionQ.isPending.value" variant="form" class="mt-8" />
    <LayoutLoadError v-else-if="deletionQ.error.value" message="Server removal information did not load." :retry="deletionQ.refetch" />
    <UAlert
      v-else class="mt-8" color="warning" title="Removal is handled by the deployment operator"
      description="Remove this server through its Cloudflare or VPS deployment configuration after saving a backup. Keep the backup destination."
    />
    <UButton class="mt-5" label="Review backups" color="neutral" variant="outline" @click="$emit('backups')" />
  </div>
</template>
