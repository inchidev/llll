<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { TelemetrySettingsDTO } from '~~/shared/telemetry'

const props = defineProps<{ workspaceId: string }>()
const toast = useToast()
const queryClient = useQueryClient()

const telemetryQ = useQuery({
  queryKey: computed(() => ['telemetry', props.workspaceId]),
  queryFn: () => $fetch<TelemetrySettingsDTO>(`/api/workspaces/${props.workspaceId}/telemetry`),
})
const save = useMutation({
  mutationFn: (enabled: boolean) => $fetch<TelemetrySettingsDTO>(`/api/workspaces/${props.workspaceId}/telemetry`, {
    method: 'PATCH',
    body: { enabled },
  }),
  onSuccess: async (value) => {
    queryClient.setQueryData(['telemetry', props.workspaceId], value)
    toast.add({ title: value.enabled ? 'Anonymous heartbeat enabled' : 'Anonymous heartbeat disabled', color: 'success' })
  },
  onError: error => toast.add({ title: errorMessage(error), color: 'error' }),
})
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Telemetry</h1>
    <p class="mt-1 text-sm text-muted">Help show how many independent L4 installations are running.</p>

    <LayoutSkeleton v-if="telemetryQ.isPending.value" variant="form" :rows="2" class="mt-8" />
    <LayoutLoadError v-else-if="telemetryQ.error.value" message="Telemetry settings did not load." :retry="telemetryQ.refetch" />
    <template v-else-if="telemetryQ.data.value">
      <div class="mt-8 rounded-lg border border-default bg-elevated p-5">
        <div class="flex items-start justify-between gap-6">
          <div>
            <p class="text-sm font-medium text-highlighted">Share an anonymous weekly heartbeat</p>
            <p class="mt-1 max-w-2xl text-sm leading-6 text-muted">
              Sends the installation ID, L4 version, time, and whether Cloudflare resource types are configured. It never sends workspace names, domains, people, messages, files, or usage amounts.
            </p>
          </div>
          <USwitch
            :model-value="telemetryQ.data.value.enabled"
            :disabled="!telemetryQ.data.value.available || save.isPending.value"
            aria-label="Share an anonymous weekly heartbeat"
            @update:model-value="save.mutate(Boolean($event))"
          />
        </div>
      </div>

      <UAlert
        v-if="!telemetryQ.data.value.available"
        class="mt-4"
        color="neutral"
        variant="subtle"
        title="Heartbeat is unavailable for this deployment"
        description="Guided installations receive anonymous telemetry credentials automatically. Manual deployments do not report unless they are configured explicitly."
      />
    </template>
  </div>
</template>
