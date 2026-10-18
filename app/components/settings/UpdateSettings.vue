<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { UpdateStatusDTO } from '~~/shared/releases'
import { formatDateTime } from '~~/shared/format'
const { api } = useApi()

const props = defineProps<{ workspaceId: string }>()

const updateQ = useQuery({
  queryKey: computed(() => ['updates', props.workspaceId]),
  queryFn: () => api<UpdateStatusDTO>(`/api/workspaces/${props.workspaceId}/updates`),
  staleTime: 6 * 60 * 60 * 1000,
})

const status = computed(() => updateQ.data.value)
const releaseLabel = computed(() => status.value?.releasesBehind === 1 ? 'release' : 'releases')
</script>

<template>
  <div>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Updates</h1>
        <p class="mt-1 text-sm text-muted">Install stable L4 releases published on GitHub.</p>
      </div>
      <UButton
        icon="i-ph-arrows-clockwise"
        color="neutral"
        variant="ghost"
        square
        aria-label="Check for updates"
        :loading="updateQ.isFetching.value"
        @click="updateQ.refetch()"
      />
    </div>

    <LayoutSkeleton v-if="updateQ.isPending.value" variant="form" :rows="2" class="mt-8" />
    <UAlert
      v-else-if="updateQ.error.value"
      class="mt-8"
      color="error"
      title="Could not check for updates"
      description="Your server is still available. Try again later."
    />
    <template v-else-if="status">
      <UAlert
        v-if="status.checkFailed"
        class="mt-8"
        color="warning"
        title="Could not check GitHub Releases"
        :description="`Installed version: ${status.installedVersion}. Your server is still available.`"
      />

      <div v-else class="mt-8 rounded-lg border border-default bg-elevated p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-highlighted">L4 {{ status.installedVersion }}</p>
            <p v-if="status.updateAvailable" class="mt-1 text-sm text-warning">{{ status.releasesBehind }} {{ releaseLabel }} behind</p>
            <p v-else class="mt-1 text-sm text-success">Up to date</p>
          </div>
          <UBadge :label="'Operator deployment'" color="neutral" variant="subtle" />
        </div>

        <div v-if="status.latestRelease" class="mt-6 border-t border-default pt-5">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="text-sm font-medium text-highlighted">{{ status.latestRelease.name }}</p>
            <p class="text-xs text-muted">{{ formatDateTime(status.latestRelease.publishedAt) }}</p>
          </div>
          <p v-if="status.updateAvailable && status.latestRelease.notes" class="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted">{{ status.latestRelease.notes }}</p>
        </div>

        <div class="mt-6 flex flex-wrap gap-2">
          <UButton
            v-if="status.latestRelease"
            :to="status.latestRelease.url"
            external
            target="_blank"
            label="View release"
            trailing-icon="i-ph-arrow-up-right"
            color="neutral"
            variant="outline"
          />
        </div>
      </div>

      <UAlert
        v-if="status.updateAvailable && status.management === 'operator'"
        class="mt-4"
        color="neutral"
        title="Repository deployment"
        description="Update the connected repository and apply its D1 migrations before deploying the new Worker."
      />
    </template>
  </div>
</template>
