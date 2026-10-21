<script setup lang="ts">
import { useNow } from '@vueuse/core'
import { useQuery } from '@tanstack/vue-query'
import type { UpdateStatusDTO } from '~~/shared/releases'
import { activeUpdate, type ServerUpdateJob } from '~~/shared/server-updates'
import { compareVersions } from '~~/shared/release-version'
import { formatBytes, formatDateTime } from '~~/shared/format'

const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const { $pwa } = useNuxtApp()
const toast = useToast()
const prereleases = ref(false)
const selected = ref('')
const hook = ref('')
const editingHook = ref(false)
const busy = ref(false)
const attemptedRequest = ref<{ id: string; release: string } | null>(null)
const updateQ = useQuery({
  queryKey: computed(() => ['updates', props.serverId, prereleases.value]),
  queryFn: () => api<UpdateStatusDTO>(`/api/servers/${props.serverId}/updates`, { query: { prereleases: prereleases.value } }),
  staleTime: 0,
  refetchOnMount: 'always',
})
const status = computed(() => updateQ.data.value)
const progressQ = useQuery({
  queryKey: computed(() => ['update-progress', props.serverId]),
  queryFn: () => api<{ installedVersion: string; configured: boolean; job: ServerUpdateJob | null; buildUrl?: string | null }>(`/api/servers/${props.serverId}/updates/progress`),
  enabled: computed(() => status.value?.updateControl?.available === true),
  staleTime: 0,
  refetchInterval: query => activeUpdate(query.state.data?.job ?? null) ? 4000 : false,
})
const job = computed(() => progressQ.data.value?.job ?? status.value?.updateControl?.job ?? null)
const now = useNow({ interval: 10000 })
const active = computed(() => activeUpdate(job.value))
const canResume = computed(() => Boolean(job.value && active.value && (['queued', 'attention'].includes(job.value.stage) || now.value.getTime() - Date.parse(job.value.updatedAt) > 5 * 60 * 1000)))
const installed = computed(() => progressQ.data.value?.installedVersion ?? status.value?.installedVersion ?? '')
const configured = computed(() => progressQ.data.value?.configured ?? status.value?.updateControl?.configured ?? false)
const buildUrl = computed(() => progressQ.data.value?.buildUrl ?? status.value?.updateControl?.buildUrl)
const choices = computed(() => (status.value?.releases ?? []).filter(release => installed.value && compareVersions(release.tagName, installed.value) > 0))
const selectedRelease = computed(() => choices.value.find(r => r.tagName === selected.value))
const labels = { queued: 'Waiting for Build', backing_up: 'Creating and verifying backup', updating: 'Updating Server', verifying: 'Verifying Server', complete: 'Server updated', failed: 'Stopped before deployment', attention: 'Deployment needs verification', cancelled: 'Request cancelled' }
watch(choices, (values) => { if (!values.some(r => r.tagName === selected.value)) selected.value = values[0]?.tagName ?? '' }, { immediate: true })
watch(() => job.value?.stage, async (stage, previous) => {
  if (stage === 'failed' || stage === 'cancelled') attemptedRequest.value = null
  if (stage === 'complete' && previous !== 'complete') {
    await updateQ.refetch()
    await navigator.serviceWorker?.getRegistration().then(registration => registration?.update()).catch(() => {})
  }
})
async function refresh() { await Promise.all([updateQ.refetch(), progressQ.refetch()]) }
async function saveHook() {
  busy.value = true
  try {
    await api(`/api/servers/${props.serverId}/updates/config`, { method: 'PATCH', body: { hook: hook.value } })
    hook.value = ''; editingHook.value = false
    await refresh()
    toast.add({ title: 'Build hook connected', color: 'success' })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
async function start() {
  if (!selectedRelease.value || active.value || busy.value) return
  busy.value = true
  attemptedRequest.value = attemptedRequest.value?.release === selected.value ? attemptedRequest.value : { id: crypto.randomUUID(), release: selected.value }
  try {
    await api(`/api/servers/${props.serverId}/updates/request`, { method: 'POST', body: { requestId: attemptedRequest.value.id, release: selected.value, prereleases: prereleases.value } })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally {
    await progressQ.refetch(); busy.value = false
  }
}
async function resume(cancel = false) {
  if (!job.value || busy.value) return
  busy.value = true
  try {
    await api(`/api/servers/${props.serverId}/updates/resume`, { method: 'POST', body: { requestId: job.value.id, cancel } })
    if (cancel) attemptedRequest.value = null
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally {
    await progressQ.refetch(); busy.value = false
  }
}
</script>

<template>
  <div class="min-w-0 space-y-6" :data-update-blocked="active">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Updates</h1>
        <p class="mt-1 text-sm text-muted">Choose a release. A verified backup is saved before your Server is updated.</p>
      </div>
      <UButton icon="i-ph-arrows-clockwise" color="neutral" variant="ghost" square aria-label="Check for updates" :loading="updateQ.isFetching.value" @click="refresh" />
    </div>
    <LayoutSkeleton v-if="updateQ.isPending.value" variant="form" :rows="2" />
    <UAlert v-else-if="updateQ.error.value" color="error" title="Could not load update settings" description="Your Server is still available. Try refreshing." />
    <template v-if="status">
      <div class="rounded-lg border border-default bg-elevated p-5">
        <p class="text-sm text-muted">Installed version</p>
        <p class="mt-1 font-medium text-highlighted">L4 {{ installed }}</p>
      </div>
      <section v-if="job" class="space-y-4 rounded-lg border border-default p-5" aria-live="polite">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-medium text-highlighted">{{ labels[job.stage] }}</h2>
          <UBadge :label="`${job.sourceVersion} → ${job.targetVersion}`" color="neutral" variant="subtle" />
        </div>
        <p v-if="job.stage === 'queued'" class="text-sm text-muted">The request is saved on this Server. You can close this page and return later. If another Build was already queued, start this request again after it finishes.</p>
        <p v-if="job.stage === 'backing_up'" class="text-sm text-muted">Keep Server activity low while the database and files are archived. Deployment starts only after the saved archive passes verification.</p>
        <p v-if="job.backup" class="break-all text-sm text-muted">{{ job.backup.verified ? 'Backup verified' : 'Backup uploaded' }} · {{ formatBytes(job.backup.sizeBytes) }} · {{ formatDateTime(job.backup.createdAt) }}<br>{{ job.backup.key }}</p>
        <UAlert v-if="job.error" :color="job.stage === 'attention' ? 'warning' : 'error'" :title="job.error" />
        <UAlert v-if="progressQ.error.value && active" color="warning" title="Waiting for the Server" description="The Build may still be running. Refresh this page before starting any other update." />
        <div class="flex flex-wrap gap-2">
          <UButton v-if="buildUrl" :to="buildUrl" external target="_blank" label="Build log" color="neutral" variant="outline" trailing-icon="i-ph-arrow-up-right" />
          <UButton v-if="canResume" :label="job.stage === 'queued' ? 'Start Build again' : 'Resume stopped Build'" color="neutral" variant="outline" :loading="busy" @click="resume()" />
          <UButton v-if="job.stage === 'queued'" label="Cancel request" color="neutral" variant="ghost" :disabled="busy" @click="resume(true)" />
          <UButton v-if="job.stage === 'complete' && $pwa?.waiting.value" label="Update Client" data-client-update-action :loading="$pwa.updating.value" @click="$pwa.update()" />
        </div>
      </section>
      <UAlert v-if="!status.updateControl?.available" color="neutral" title="Operator-managed deployment" :description="status.updateControl?.reason || 'Use your deployment operator to update this Server.'" />
      <template v-else>
        <section v-if="!configured || editingHook" class="space-y-4 rounded-lg border border-default p-5">
          <h2 class="font-medium text-highlighted">Connect this Server’s Build</h2>
          <p class="text-sm text-muted">Use a deploy hook for this Server’s Git-connected L4 Build. It can only start a Build; no Cloudflare account API token is stored here.</p>
          <form class="space-y-4" @submit.prevent="saveHook">
            <UFormField label="Cloudflare Workers Build deploy hook" description="For an existing Server, create a hook for its L4 repository branch in Cloudflare Workers → Builds → Deploy hooks. New L4 Servers connect it automatically.">
              <UInput v-model="hook" type="password" class="w-full" autocomplete="new-password" placeholder="https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/…" :disabled="busy || active" />
            </UFormField>
            <UButton type="submit" label="Connect Build hook" :loading="busy" :disabled="!hook.trim() || active" />
          </form>
        </section>
        <div v-else-if="status.updateControl.source === 'saved'" class="flex items-center justify-between gap-3 text-sm">
          <span class="text-muted">Build hook connected</span>
          <UButton label="Change hook" color="neutral" variant="link" :disabled="active" @click="editingHook = true" />
        </div>
        <section class="space-y-4">
          <UCheckbox v-model="prereleases" label="Include prereleases" :disabled="busy || active" />
          <UAlert v-if="status.checkFailed" color="warning" title="Could not check GitHub Releases" description="The installed Server is still available. Refresh to retry; saved update progress is shown above." />
          <template v-else-if="choices.length">
            <UFormField label="Release" description="Only published releases newer than the installed version can be selected.">
              <USelect v-model="selected" class="w-full" :items="choices.map(r => ({ label: r.tagName, value: r.tagName }))" :disabled="active || busy" />
            </UFormField>
            <a v-if="selectedRelease" :href="selectedRelease.url" target="_blank" rel="noopener noreferrer" class="text-sm underline">View {{ selectedRelease.tagName }} release notes</a>
            <p v-if="selectedRelease?.notes" class="max-h-52 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted">{{ selectedRelease.notes }}</p>
            <p class="text-sm text-muted">Database and files are backed up to this deployment’s separate backup bucket. Existing Accounts, UUID and storage are kept. This may take several minutes.</p>
            <UButton label="Back up and update" icon="i-ph-cloud-arrow-up" :loading="busy" :disabled="!configured || active || !selectedRelease" @click="start" />
          </template>
          <p v-else class="text-sm text-muted">No newer {{ prereleases ? 'published' : 'stable' }} release is available.</p>
        </section>
      </template>
    </template>
  </div>
</template>
