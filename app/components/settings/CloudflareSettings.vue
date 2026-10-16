<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { InstallationDomainSettingsDTO, InstallationManagementStatusDTO } from '~~/shared/releases'

const props = withDefaults(defineProps<{
  workspaceId: string
  /** Where the workspace runs at a glance, or its custom address. */
  view?: 'overview' | 'domains'
}>(), { view: 'overview' })
defineEmits<{ navigate: [section: string] }>()

const { api } = useApi()
const route = useRoute()
const toast = useToast()
const appBusy = ref(false)

const managementQ = useQuery({
  queryKey: computed(() => ['installation-management', props.workspaceId]),
  queryFn: () => api<InstallationManagementStatusDTO>(`/api/workspaces/${props.workspaceId}/management`),
})
const domainsQ = useQuery({
  queryKey: computed(() => ['installation-domains', props.workspaceId]),
  queryFn: () => api<InstallationDomainSettingsDTO>(`/api/workspaces/${props.workspaceId}/domains`),
  // Zones come from the Control Plane and take seconds to list. The Overview
  // starts the request in the background without waiting on it, and the result
  // is kept for a while so the Domain tab opens instantly.
  staleTime: 5 * 60_000,
})
const loading = computed(() => managementQ.isPending.value || (props.view === 'domains' && domainsQ.isPending.value))
const loadError = computed(() => managementQ.error.value || (props.view === 'domains' ? domainsQ.error.value : null))
function retryLoad() {
  return Promise.all([managementQ.refetch(), props.view === 'domains' ? domainsQ.refetch() : null])
}

const status = computed(() => managementQ.data.value)
const domains = computed(() => domainsQ.data.value)
const activeZones = computed(() => (domains.value?.zones ?? []).filter(zone => zone.status === 'active'))

const appState = reactive({ zoneId: '', subdomain: '' })
const appInput = ref<{ hostname: string } | null>(null)
const appLabelValid = computed(() => !appState.subdomain.trim() || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(appState.subdomain.trim()))
watch(activeZones, (zones) => {
  if (!zones.some(zone => zone.id === appState.zoneId)) appState.zoneId = zones[0]?.id || ''
}, { immediate: true })

// Disconnecting moves the workspace to another URL, so it asks first.
const confirmDisconnect = ref<{ kind: 'app' } | null>(null)
async function runDisconnect() {
  await disconnectApp()
  confirmDisconnect.value = null
}

async function connectAppDomain() {
  if (!appInput.value?.hostname || !appLabelValid.value) return
  appBusy.value = true
  try {
    const result = await api<{ hostname: string }>(`/api/workspaces/${props.workspaceId}/app-domain`, {
      method: 'PUT',
      body: { zoneId: appState.zoneId, hostname: appState.subdomain.trim() },
    })
    toast.add({ title: `${result.hostname} connected`, color: 'success' })
    await navigateTo(`https://${result.hostname}${route.fullPath}`, { external: true })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    appBusy.value = false
  }
}

async function disconnectApp() {
  appBusy.value = true
  try {
    const result = await api<{ hostname: string }>(`/api/workspaces/${props.workspaceId}/app-domain`, { method: 'DELETE' })
    toast.add({ title: 'Custom address disconnected', color: 'success' })
    await navigateTo(`https://${result.hostname}${route.fullPath}`, { external: true })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    appBusy.value = false
  }
}
</script>

<template>
  <div>
    <SettingsHeader
      :title="view === 'domains' ? 'Domain' : 'System'"
      :description="view === 'domains'
        ? 'The address people open this workspace at.'
        : 'Where this workspace runs and what it has enabled.'"
    />

    <LayoutSkeleton v-if="loading" variant="form" :rows="3" class="mt-8" />
    <LayoutLoadError v-else-if="loadError" :message="`Cloudflare settings did not load. ${errorMessage(loadError)}`" :retry="retryLoad" />
    <UAlert
      v-else-if="!status?.available || (view === 'domains' && !domains?.managed)"
      class="mt-8"
      color="neutral"
      title="Repository deployment"
      description="This Worker has no managed Installation identity. Configure its domains from the repository and Cloudflare dashboard."
    />

    <template v-else-if="view === 'overview' && status">
      <div class="mt-8 grid gap-3 sm:grid-cols-2">
        <div class="rounded-lg border border-default p-4">
          <p class="text-xs text-muted">Address</p>
          <p class="mt-1 truncate font-medium text-highlighted">{{ status.hostname || 'workers.dev' }}</p>
        </div>
        <div class="rounded-lg border border-default p-4">
          <p class="text-xs text-muted">Email domains</p>
          <p class="mt-1 break-words font-medium text-highlighted">{{ status.emailDomains.length ? status.emailDomains.join(', ') : 'None connected' }}</p>
        </div>
        <div class="rounded-lg border border-default p-4">
          <p class="text-xs text-muted">Worker</p>
          <p class="mt-1 truncate font-medium text-highlighted">{{ status.workerName }}</p>
        </div>
        <div class="rounded-lg border border-default p-4">
          <p class="text-xs text-muted">Live</p>
          <p class="mt-1 font-medium text-highlighted">{{ status.liveEnabled ? 'RealtimeKit connected' : 'Not connected' }}</p>
        </div>
      </div>
      <p class="mt-6 flex items-start gap-2 text-sm text-muted">
        <UIcon name="i-ph-lock-simple" class="mt-0.5 size-4 shrink-0" />
        This workspace runs on your own Cloudflare account. Your Cloudflare credential stays in the L4 Control Plane, and the workspace can only run fixed operations on itself.
      </p>
    </template>

    <template v-else-if="view === 'domains' && domains">
      <div v-if="domains.appDomain" class="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-default p-4">
        <div class="min-w-0">
          <p class="truncate font-medium text-highlighted">{{ domains.appDomain.hostname }}</p>
          <p class="mt-1 text-xs text-muted">Cloudflare zone {{ domains.appDomain.zoneName }}</p>
        </div>
        <UButton label="Disconnect" color="neutral" variant="outline" size="sm" :loading="appBusy" @click="confirmDisconnect = { kind: 'app' }" />
      </div>

      <form v-else class="mt-8 max-w-lg" @submit.prevent="connectAppDomain">
        <UFormField label="Custom address" :error="appLabelValid ? undefined : 'Use letters, numbers and hyphens, like chat'">
          <SettingsDomainInput
            ref="appInput"
            v-model:label="appState.subdomain"
            v-model:zone-id="appState.zoneId"
            :zones="activeZones"
            placeholder="chat"
            :example="hostname => `People will open https://${hostname}`"
          />
        </UFormField>
        <UButton type="submit" class="mt-3" label="Connect" :loading="appBusy" :disabled="!appInput?.hostname || !appLabelValid" />
      </form>

      <p class="mt-8 text-sm text-muted">
        Email domains are managed in <button type="button" class="text-highlighted underline-offset-2 hover:underline" @click="$emit('navigate', 'email')">Email settings</button>.
      </p>
    </template>

    <UModal
      :open="Boolean(confirmDisconnect)"
      title="Disconnect the custom address?"
      @update:open="(value: boolean) => { if (!value) confirmDisconnect = null }"
    >
      <template #body>
        <p class="text-sm text-muted">The workspace moves back to its workers.dev address and this page reloads there. Links to the current address stop working.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="confirmDisconnect = null" />
        <UButton color="error" label="Disconnect" :loading="appBusy" @click="runDisconnect" />
      </template>
    </UModal>
  </div>
</template>
