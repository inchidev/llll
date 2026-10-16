<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ServerDeletionStartDTO, ServerDeletionStatusDTO } from '~~/shared/deletion'

const props = defineProps<{
  workspaceId: string
  workspaceName: string
}>()

const emit = defineEmits<{
  backups: []
}>()

const confirmOpen = ref(false)
const starting = ref(false)
const toast = useToast()

const deletionQ = useQuery({
  queryKey: computed(() => ['server-deletion', props.workspaceId]),
  queryFn: () => $fetch<ServerDeletionStatusDTO>(`/api/workspaces/${props.workspaceId}/deletion`),
})

function openBackups() {
  confirmOpen.value = false
  emit('backups')
}

async function continueToCloudflare() {
  starting.value = true
  try {
    const result = await $fetch<ServerDeletionStartDTO>(`/api/workspaces/${props.workspaceId}/deletion`, { method: 'POST' })
    window.location.assign(result.uninstallUrl)
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
    starting.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Danger Zone</h1>
    <p class="mt-1 text-sm text-muted">Irreversible actions for this workspace.</p>

    <div class="mt-8 rounded-lg border border-error/60">
      <div class="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <p class="font-medium text-highlighted">Delete this workspace</p>
          <p class="mt-1 text-sm leading-6 text-muted">
            Permanently remove {{ workspaceName }}, its Worker, database, live files, tickets, and runtime resources from Cloudflare.
          </p>
        </div>
        <UButton
          label="Delete workspace"
          trailing-icon="i-ph-trash"
          color="error"
          variant="soft"
          class="shrink-0"
          :loading="deletionQ.isPending.value"
          :disabled="Boolean(deletionQ.error.value)"
          @click="confirmOpen = true"
        />
      </div>
    </div>

    <UAlert
      v-if="deletionQ.error.value"
      class="mt-4"
      color="error"
      variant="subtle"
      title="Could not prepare workspace deletion"
      description="Reload Workspace Settings and try again."
    />

    <UAlert
      v-else-if="deletionQ.data.value?.installationKind === 'manual'"
      class="mt-4"
      color="warning"
      variant="subtle"
      title="Manual Cloudflare installation"
      description="L4 cannot know which bound resources are shared with other Workers. Create a backup, then remove this Worker and only the resources you own from the Cloudflare dashboard."
    />

    <UModal
      v-model:open="confirmOpen"
      title="Delete this workspace?"
      description="This cannot be undone. You can create an optional backup before continuing."
      :ui="{ footer: 'justify-between' }"
    >
      <template #body>
        <UAlert
          color="warning"
          variant="subtle"
          title="Back up anything you need first"
          description="A backup is optional, but after Cloudflare deletion the database and live file bucket cannot be recovered through L4."
        />
        <p class="mt-4 text-sm leading-6 text-muted">
          The installer will verify the Cloudflare account that owns this installation and require the workspace address before anything is deleted. An external backup bucket is never deleted.
        </p>
      </template>
      <template #footer>
        <UButton label="Review backup options" color="neutral" variant="outline" @click="openBackups" />
        <UButton
          v-if="deletionQ.data.value?.installationKind === 'guided'"
          label="Continue to Cloudflare"
          trailing-icon="i-ph-arrow-up-right"
          color="error"
          :loading="starting"
          @click="continueToCloudflare"
        />
        <UButton
          v-else
          to="https://dash.cloudflare.com/"
          external
          target="_blank"
          label="Open Cloudflare"
          trailing-icon="i-ph-arrow-up-right"
          color="error"
        />
      </template>
    </UModal>
  </div>
</template>
