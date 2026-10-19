<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ServerManagementStatusDTO } from '~~/shared/releases'
const props = withDefaults(defineProps<{ serverId: string, view?: 'overview' | 'domains' }>(), { view: 'overview' })
const { api } = useApi()
const managementQ = useQuery({
  queryKey: computed(() => ['server-deployment', props.serverId]),
  queryFn: () => api<ServerManagementStatusDTO>(`/api/servers/${props.serverId}/management`),
})
const status = computed(() => managementQ.data.value)
</script>
<template>
  <div>
    <SettingsHeader :title="view === 'domains' ? 'Server address' : 'Server deployment'" description="This server has its own data and runtime. Accounts and login stay local to this server." />
    <LayoutSkeleton v-if="managementQ.isPending.value" variant="form" class="mt-8" />
    <LayoutLoadError v-else-if="managementQ.error.value" message="Server deployment information did not load." :retry="managementQ.refetch" />
    <template v-else>
      <dl class="mt-8 grid gap-4 text-sm">
        <div v-if="status?.hostname"><dt class="text-muted">Server address</dt><dd class="mt-1 break-all">{{ status.hostname }}</dd></div>
        <div v-if="status?.workerName"><dt class="text-muted">Runtime</dt><dd class="mt-1">{{ status.workerName }}</dd></div>
      </dl>
      <UAlert class="mt-6" color="neutral" title="Configured by the server operator" description="Manage domain routing and deployment credentials through your Cloudflare account or VPS configuration. Server settings contain this server's backups and optional provider connections." />
    </template>
  </div>
</template>
