<script setup lang="ts">
import type { AdminSession, ProgressState, Workspace } from '../composables/useAdmin'

const session = useState<AdminSession | null>('admin-session')
const route = useRoute()
const toast = useToast()
const createOpen = ref(false)
const updating = ref('')
const adminSteps = ref<Record<string, ProgressState>>({})

const { data, pending, error, refresh } = await useFetch<{ workspaces: Workspace[] }>('/api/workspaces', { server: false })
const workspaces = computed(() => data.value?.workspaces ?? [])
const connected = computed(() => Boolean(session.value?.credential?.connected || session.value?.credential?.pendingHandover))

async function reloadSession() {
  session.value = await $fetch<AdminSession>('/api/session')
  await refresh()
}

onMounted(() => {
  const message = typeof route.query.cloudflare === 'string' ? route.query.cloudflare : ''
  if (!message) return
  if (message === 'connected') toast.add({ title: 'Cloudflare connected', color: 'success' })
  else toast.add({ title: message, color: 'error' })
  void navigateTo('/', { replace: true })
  void reloadSession()
})

async function updateWorkspace(workspace: Workspace) {
  updating.value = workspace.workerName
  try {
    const result = await streamProgress<{ version: string }>(`/api/workspaces/${workspace.workerName}/update`, {}, () => {})
    toast.add({ title: `${workspace.appName} is on L4 ${result.version}`, color: 'success' })
  }
  catch (cause) {
    toast.add({ title: failureMessage(cause), color: 'error' })
  }
  finally {
    updating.value = ''
    await refresh()
  }
}

async function updateAdmin() {
  updating.value = 'admin'
  adminSteps.value = {}
  try {
    const result = await streamProgress<{ version: string, updated: boolean }>('/api/admin/update', {}, (step, state) => {
      adminSteps.value = { ...adminSteps.value, [step]: state }
    })
    toast.add({ title: result.updated ? `Admin updated to ${result.version}. Reloading…` : 'The Admin is up to date', color: 'success' })
    if (result.updated) setTimeout(() => window.location.reload(), 4000)
  }
  catch (cause) {
    toast.add({ title: failureMessage(cause), color: 'error' })
  }
  finally {
    updating.value = ''
  }
}

async function setAutomatic(key: 'admin' | 'workspaces', value: boolean) {
  const current = session.value?.automaticUpdates ?? { admin: true, workspaces: false }
  const next = { ...current, [key]: value }
  await adminFetch('/api/admin/settings', { method: 'PUT', body: { automaticUpdates: next } })
  if (session.value) session.value = { ...session.value, automaticUpdates: next }
}
</script>

<template>
  <AdminShell>
    <div class="space-y-8">
      <AccountRecovery />
      <CloudflareConnection v-if="session" :session="session" @changed="reloadSession" />

      <section>
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="text-lg font-semibold text-highlighted">Workspaces</h2>
          <UButton class="ms-auto" label="New workspace" icon="i-ph-plus" :disabled="!connected" @click="createOpen = true" />
        </div>
        <UAlert v-if="error" class="mt-4" color="error" title="Workspaces could not be read" :description="failureMessage(error)" />
        <div v-else-if="pending" class="mt-6 flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-spinner-gap" class="size-4 animate-spin" /> Reading this Cloudflare account
        </div>
        <p v-else-if="!workspaces.length" class="mt-4 text-sm text-muted">No L4 workspaces in this account yet.</p>
        <ul v-else class="mt-4 divide-y divide-default rounded-lg border border-default">
          <li v-for="workspace in workspaces" :key="workspace.workerName" class="flex flex-wrap items-center gap-3 p-4">
            <div class="min-w-0 flex-1">
              <NuxtLink :to="`/workspaces/${workspace.workerName}`" class="font-medium text-highlighted hover:underline">{{ workspace.appName }}</NuxtLink>
              <p class="truncate text-sm text-muted">{{ workspace.origin.replace('https://', '') }}</p>
            </div>
            <UBadge v-if="!workspace.linked" label="Not linked" color="warning" variant="subtle" />
            <UBadge :label="workspace.version ? `v${workspace.version}` : 'unknown'" color="neutral" variant="subtle" />
            <UButton
              v-if="workspace.updateAvailable || !workspace.linked"
              :label="workspace.updateAvailable ? 'Update' : 'Link'"
              size="sm"
              :loading="updating === workspace.workerName"
              :disabled="Boolean(updating)"
              @click="workspace.updateAvailable ? updateWorkspace(workspace) : navigateTo(`/workspaces/${workspace.workerName}`)"
            />
            <UButton :to="workspace.origin" target="_blank" icon="i-ph-arrow-up-right" color="neutral" variant="ghost" size="sm" aria-label="Open workspace" />
          </li>
        </ul>
      </section>

      <section class="rounded-lg border border-default p-5">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="font-semibold text-highlighted">Updates</h2>
          <span class="text-sm text-muted">Admin v{{ session?.version }}<template v-if="session?.latestVersion"> · latest v{{ session.latestVersion }}</template></span>
          <UButton v-if="session?.updateAvailable" class="ms-auto" label="Update Admin" size="sm" :loading="updating === 'admin'" @click="updateAdmin" />
        </div>
        <div class="mt-4 space-y-3">
          <USwitch :model-value="session?.automaticUpdates?.admin ?? true" label="Keep the Admin up to date automatically" @update:model-value="value => setAutomatic('admin', Boolean(value))" />
          <USwitch :model-value="session?.automaticUpdates?.workspaces ?? false" label="Update workspaces automatically when a release is published" @update:model-value="value => setAutomatic('workspaces', Boolean(value))" />
        </div>
      </section>
    </div>
    <CreateWorkspaceModal v-model:open="createOpen" :workspaces="workspaces" @created="refresh" />
  </AdminShell>
</template>
