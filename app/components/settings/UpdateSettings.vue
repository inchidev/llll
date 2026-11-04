<script setup lang="ts">
import { sha256 } from '@noble/hashes/sha2.js'
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
  queryFn: () => api<{ installedVersion: string; configured: boolean; mode?: 'build' | 'installer'; job: ServerUpdateJob | null; buildUrl?: string | null; launchUrl?: string | null }>(`/api/servers/${props.serverId}/updates/progress`),
  enabled: computed(() => status.value?.updateControl?.available === true),
  staleTime: 0,
  refetchInterval: query => activeUpdate(query.state.data?.job ?? null) ? 4000 : false,
})
const job = computed(() => progressQ.data.value?.job ?? status.value?.updateControl?.job ?? null)
const now = useNow({ interval: 10000 })
const active = computed(() => activeUpdate(job.value))
const canResume = computed(() => Boolean(job.value && active.value && (['queued', 'attention'].includes(job.value.stage) || now.value.getTime() - Date.parse(job.value.updatedAt) > 5 * 60 * 1000)))
const installed = computed(() => progressQ.data.value?.installedVersion ?? status.value?.installedVersion ?? '')
const launchUrl = computed(() => progressQ.data.value?.launchUrl ?? status.value?.updateControl?.launchUrl ?? null)
const choices = computed(() => (status.value?.releases ?? []).filter(release => installed.value && compareVersions(release.tagName, installed.value) > 0))
const selectedRelease = computed(() => choices.value.find(r => r.tagName === selected.value))
const order = ['backing_up', 'updating', 'verifying'] as const
const steps = computed(() => {
  const at = order.indexOf(job.value?.stage as typeof order[number])
  return order.map((stage, index) => ({ stage, label: labels[stage], state: at < 0 ? 'pending' : index < at ? 'done' : index === at ? 'current' : 'pending' }))
})
const labels = { queued: 'Waiting to start', backing_up: 'Creating and verifying backup', updating: 'Updating Server', verifying: 'Verifying Server', complete: 'Server updated', failed: 'Stopped before deployment', attention: 'Deployment needs verification', cancelled: 'Request cancelled' }
watch(choices, (values) => { if (!values.some(r => r.tagName === selected.value)) selected.value = values[0]?.tagName ?? '' }, { immediate: true })
watch(() => job.value?.stage, async (stage, previous) => {
  if (stage === 'failed' || stage === 'cancelled') attemptedRequest.value = null
  if (stage === 'complete' && previous !== 'complete') {
    await updateQ.refetch()
    await $pwa?.check()
  }
})
async function refresh() { await Promise.all([updateQ.refetch(), progressQ.refetch(), $pwa?.check()]) }
async function start() {
  if (!selectedRelease.value || active.value || busy.value) return
  busy.value = true
  attemptedRequest.value = attemptedRequest.value?.release === selected.value ? attemptedRequest.value : { id: crypto.randomUUID(), release: selected.value }
  try {
    await api(`/api/servers/${props.serverId}/updates/request`, { method: 'POST', body: { requestId: attemptedRequest.value.id, release: selected.value, prereleases: prereleases.value } })
    if (selfMode.value) await api(`/api/servers/${props.serverId}/updates/run`, { method: 'POST', body: { requestId: attemptedRequest.value.id } })
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
const downloading = ref(false)
async function downloadUpdateBackup() {
  if (!job.value || downloading.value) return
  downloading.value = true
  const id = job.value.id
  try {
    const blob = await api<Blob>(`/api/servers/${props.serverId}/backup`, { method: 'POST', query: { update: id }, responseType: 'blob', retry: 0 })
    const hash = sha256.create(), reader = blob.stream().getReader()
    try { while (true) { const next = await reader.read(); if (next.done) break; hash.update(next.value) } } finally { reader.releaseLock() }
    const digest = Array.from(hash.digest()).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const href = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = href; link.download = `llll-backup-before-${id}.tar`; document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(href), 60000)
    await api(`/api/servers/${props.serverId}/updates/downloaded`, { method: 'POST', body: { requestId: id, sha256: digest, sizeBytes: blob.size } })
    await progressQ.refetch()
  } catch (error) { toast.add({ title: 'Backup download did not complete', description: errorMessage(error), color: 'error' }) }
  finally { downloading.value = false }
}
// The installed Server can be newer than the cached interface until the service worker swaps it.
const clientVersion = useAppConfig().version as string
const staleClient = computed(() => Boolean(installed.value && clientVersion && installed.value !== clientVersion))
function loadClient() { if ($pwa) void $pwa.reloadLatest(); else location.reload() }
const accessCard = ref<{ connected: boolean } | null>(null)
// With Cloudflare access kept here and a backup bucket, this Server runs the update itself.
const selfMode = computed(() => Boolean(accessCard.value?.connected) && status.value?.updateControl?.backupDestination !== 'download')
const selfRun = computed(() => Boolean(job.value?.buildId?.startsWith('server-')))
async function run() {
  if (!job.value || busy.value) return
  busy.value = true
  try { await api(`/api/servers/${props.serverId}/updates/run`, { method: 'POST', body: { requestId: job.value.id } }) }
  catch (error) { toast.add({ title: 'The update did not start', description: errorMessage(error), color: 'error' }) }
  finally { await progressQ.refetch(); busy.value = false }
}
const needsDownload = computed(() => status.value?.updateControl?.backupDestination === 'download' && !job.value?.backup?.verified)
</script>

<template>
  <div class="min-w-0 space-y-6" :data-update-blocked="active">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Updates</h1>
        <p class="mt-1 text-sm text-muted">Choose a release and save a verified backup before your Server is updated.</p>
      </div>
      <UButton icon="i-ph-arrows-clockwise" color="neutral" variant="ghost" square aria-label="Check for updates" :loading="updateQ.isFetching.value" @click="refresh" />
    </div>
    <LayoutSkeleton v-if="updateQ.isPending.value" variant="form" :rows="2" />
    <UAlert v-else-if="updateQ.error.value" color="error" title="Could not load update settings" description="Your Server is still available. Try refreshing." />
    <template v-if="status">
      <!-- One card answers "what runs here and what is happening to it"; the release picker only appears when there is something to pick. -->
      <section class="space-y-4 rounded-lg border border-default p-5" aria-live="polite">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm text-muted">Installed version</p>
            <p class="mt-0.5 text-lg font-medium text-highlighted">L4 {{ installed }}</p>
          </div>
          <UBadge v-if="job && active" :label="`Updating to ${job.targetVersion}`" color="primary" variant="subtle" />
          <UBadge v-else-if="choices.length && !status.checkFailed" :label="`${choices[0]!.tagName} available`" color="primary" variant="subtle" />
          <UBadge v-else-if="status.updateControl?.available && !status.checkFailed" label="Up to date" color="success" variant="subtle" />
        </div>
        <template v-if="job && job.stage !== 'cancelled'">
          <p class="font-medium text-highlighted">{{ labels[job.stage] }}</p>
          <ol v-if="active" class="space-y-2" aria-label="Update progress">
            <li v-for="step in steps" :key="step.stage" class="flex items-center gap-2 text-sm" :class="step.state === 'pending' ? 'text-dimmed' : 'text-highlighted'">
              <UIcon :name="step.state === 'done' ? 'i-ph-check-circle' : step.state === 'current' ? 'i-ph-spinner-gap' : 'i-ph-circle'" class="size-4 shrink-0" :class="{ 'animate-spin': step.state === 'current', 'text-success': step.state === 'done' }" />
              {{ step.label }}
            </li>
          </ol>
          <p v-if="job.stage === 'complete'" class="text-sm text-muted">Updated from {{ job.sourceVersion }} · {{ formatDateTime(job.updatedAt) }}</p>
          <p v-else-if="job.stage === 'queued'" class="text-sm text-muted">{{ selfMode ? 'The request is saved. Start it here; this Server runs the update itself.' : 'The request is saved on this Server. Continue on llll.gg to authorize Cloudflare for this one update.' }}</p>
          <p v-else-if="selfRun && active" class="text-sm text-muted">This Server is updating itself. You can close this page and check back later.</p>
          <p v-else-if="job.stage === 'backing_up'" class="text-sm text-muted">Keep Server activity low while the database and files are archived.</p>
          <p v-if="job.backup" class="text-sm text-muted" :title="job.backup.key">{{ job.backup.verified ? 'Backup verified' : 'Backup uploaded' }} · {{ formatBytes(job.backup.sizeBytes) }} · {{ formatDateTime(job.backup.createdAt) }}</p>
          <UAlert v-if="job.error" :color="job.stage === 'attention' ? 'warning' : 'error'" :title="job.error" />
          <UAlert v-if="progressQ.error.value && active" color="warning" title="Waiting for the Server" :description="selfRun ? 'The Server may be switching to the new version. Refresh in a minute.' : 'The update may still be running. Open llll.gg to check its progress before starting another update.'" />
          <UAlert v-if="$pwa?.error?.value" color="warning" :title="$pwa.error.value" />
          <div class="flex flex-wrap gap-2">
            <UButton v-if="job.stage === 'complete' && ($pwa?.waiting.value || staleClient)" :label="`Load the ${installed} interface`" icon="i-ph-arrow-clockwise" data-client-update-action :loading="$pwa?.updating.value" @click="loadClient" />
            <UButton v-if="needsDownload && job.stage === 'queued'" label="Download backup" icon="i-ph-download" :loading="downloading" @click="downloadUpdateBackup" />
            <UButton v-if="selfMode && (job.stage === 'queued' || (job.stage === 'attention' && selfRun))" :label="job.stage === 'queued' ? 'Start update' : 'Retry update'" icon="i-ph-cloud-arrow-up" :loading="busy" @click="run" />
            <UButton v-if="!selfRun && !(selfMode && job.stage === 'queued') && !needsDownload && launchUrl && ['queued', 'backing_up', 'updating', 'verifying', 'attention'].includes(job.stage)" :to="launchUrl" external target="_blank" rel="noopener" :label="job.stage === 'queued' ? 'Continue on llll.gg' : 'Check or resume on llll.gg'" icon="i-ph-cloud-arrow-up" />
            <UButton v-if="!selfRun && !selfMode && canResume && launchUrl" :to="launchUrl" external target="_blank" rel="noopener" color="neutral" variant="outline" label="Open the official installer" />
            <UButton v-if="job.stage === 'queued'" label="Cancel request" color="neutral" variant="ghost" :disabled="busy" @click="resume(true)" />
          </div>
        </template>
      </section>
      <template v-if="!status.updateControl?.available">
        <UAlert color="neutral" title="Updates are managed outside L4" :description="status.updateControl?.reason || 'Use your deployment operator to update this Server.'" />
        <p v-if="status.updateAvailable && status.latestRelease" class="text-sm text-muted">L4 {{ status.latestRelease.tagName }} is available. <a :href="status.latestRelease.url" target="_blank" rel="noopener noreferrer" class="underline">Release notes</a></p>
      </template>
      <template v-else>
        <section class="space-y-4">
          <UCheckbox v-if="!active" v-model="prereleases" label="Include prereleases" :disabled="busy" />
          <UAlert v-if="status.checkFailed" color="warning" title="Could not check GitHub Releases" description="The installed Server is still available. Refresh to retry; saved update progress is shown above." />
          <template v-else-if="choices.length && !active">
            <UFormField label="Release" description="Only published releases newer than the installed version can be selected.">
              <USelect v-model="selected" class="w-full" :items="choices.map(r => ({ label: r.tagName, value: r.tagName }))" :disabled="active || busy" />
            </UFormField>
            <a v-if="selectedRelease" :href="selectedRelease.url" target="_blank" rel="noopener noreferrer" class="text-sm underline">View {{ selectedRelease.tagName }} release notes</a>
            <!-- Release notes are Markdown; the release title repeats the version, so it is dropped. -->
            <div v-if="selectedRelease?.notes" class="release-notes max-h-72 overflow-y-auto rounded-md border border-default p-3 text-sm text-muted"><ChatMarkdownView :content="selectedRelease.notes.replace(/^#\s+[^\n]*\n+/u, '')" /></div>
            <p class="text-sm text-muted">{{ status.updateControl?.backupDestination === 'download' ? 'Download a backup of the database and files to your computer before continuing in the installer.' : 'Database and files are saved to the separate backup bucket and verified before the update.' }} Existing Accounts, UUID and storage are kept.</p>
            <UButton label="Back up and update" icon="i-ph-cloud-arrow-up" :loading="busy" :disabled="active || !selectedRelease" @click="start" />
          </template>
          <p v-else-if="!active" class="text-sm text-muted">No newer {{ prereleases ? 'published' : 'stable' }} release is available.</p>
        </section>
      </template>
      <SettingsCloudflareAccessCard ref="accessCard" :server-id="serverId" />
    </template>
  </div>
</template>

<style scoped>
.release-notes :deep(h2) { margin-top: 0.75rem; font-weight: 600; color: var(--ui-text-highlighted); }
.release-notes :deep(h2:first-child) { margin-top: 0; }
.release-notes :deep(ul) { margin-top: 0.25rem; padding-inline-start: 1.25rem; list-style: disc; }
.release-notes :deep(li) { margin-top: 0.125rem; }
</style>
