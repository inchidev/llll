<script setup lang="ts">
import type { AdminSession, ProgressState, Workspace } from '../../composables/useAdmin'

type Detail = {
  workspace: Workspace
  ownerSetupRequired: boolean | null
  domains: null | { error: string } | {
    appDomain: null | { hostname: string }
    emailDomains: Array<{ id: string, domain: string, sendingEnabled: boolean }>
  }
  live: { provisioned: boolean, appId: string | null }
}

const route = useRoute()
const session = useState<AdminSession | null>('admin-session')
const toast = useToast()
const name = computed(() => String(route.params.name))
const busy = ref('')
const setupUrl = ref('')
const updateSteps = ref<Record<string, ProgressState>>({})
const deleteOpen = ref(false)
const deleteClaim = ref('')
const deleteConfirmation = ref('')

const { data, pending, error, refresh } = await useFetch<Detail>(() => `/api/workspaces/${name.value}`, { server: false })
const workspace = computed(() => data.value?.workspace)
const domains = computed(() => data.value?.domains && !('error' in data.value.domains) ? data.value.domains : null)

onMounted(() => {
  // Workspace Settings links here with the deletion claim in the fragment.
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const claim = hash.get('deletion')
  if (claim) {
    deleteClaim.value = claim
    deleteOpen.value = true
    history.replaceState(null, '', route.path)
  }
})

async function run(label: string, work: () => Promise<void>) {
  busy.value = label
  try {
    await work()
  }
  catch (cause) {
    toast.add({ title: failureMessage(cause), color: 'error' })
  }
  finally {
    busy.value = ''
  }
}

const update = () => run('update', async () => {
  updateSteps.value = {}
  const result = await streamProgress<{ version: string, linkedToAdmin?: boolean }>(`/api/workspaces/${name.value}/update`, {}, (step, state) => {
    updateSteps.value = { ...updateSteps.value, [step]: state }
  })
  toast.add({ title: `Updated to L4 ${result.version}${result.linkedToAdmin ? ' and linked to this Admin' : ''}`, color: 'success' })
  await refresh()
})

const link = () => run('link', async () => {
  await adminFetch(`/api/workspaces/${name.value}/link`, { method: 'POST' })
  toast.add({ title: 'Workspace linked to this Admin', color: 'success' })
  await refresh()
})

const ownerSetup = () => run('owner', async () => {
  const result = await adminFetch<{ setupUrl: string }>(`/api/workspaces/${name.value}/owner-setup`, { method: 'POST' })
  setupUrl.value = result.setupUrl
})

const enableFiles = () => run('files', async () => {
  await adminFetch(`/api/workspaces/${name.value}/files`, { method: 'POST' })
  toast.add({ title: 'R2 connected. Reload the workspace to enable files and backups.', color: 'success' })
  await refresh()
})

const provisionLive = () => run('live', async () => {
  await adminFetch(`/api/workspaces/${name.value}/live`, { method: 'POST' })
  toast.add({ title: 'Live is ready for this workspace', color: 'success' })
  await refresh()
})

const remove = () => run('delete', async () => {
  const result = await adminFetch<{ deletedResources: string[], remainingResources: string[] }>(`/api/workspaces/${name.value}/delete`, {
    method: 'POST',
    body: { claim: deleteClaim.value.trim(), confirmation: deleteConfirmation.value.trim() },
  })
  toast.add({
    title: 'Workspace deleted',
    description: result.remainingResources.length ? `Still to remove by hand: ${result.remainingResources.join(', ')}` : undefined,
    color: 'success',
  })
  await navigateTo('/')
})
</script>

<template>
  <AdminShell>
    <UButton to="/" label="Workspaces" icon="i-ph-arrow-left" color="neutral" variant="ghost" size="sm" class="-ms-2 mb-4" />
    <UAlert v-if="error" color="error" title="Workspace could not be read" :description="failureMessage(error)" />
    <div v-else-if="pending || !workspace" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-spinner-gap" class="size-4 animate-spin" /> Reading the workspace
    </div>
    <div v-else class="space-y-6">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold text-highlighted">{{ workspace.appName }}</h1>
        <UBadge :label="`v${workspace.version}`" color="neutral" variant="subtle" />
        <UBadge v-if="workspace.linked" label="Linked" color="success" variant="subtle" />
        <UButton class="ms-auto" :to="workspace.origin" target="_blank" label="Open workspace" trailing-icon="i-ph-arrow-up-right" color="neutral" variant="outline" size="sm" />
      </div>

      <section class="rounded-lg border border-default p-5">
        <h2 class="font-semibold text-highlighted">Release</h2>
        <p class="mt-1 text-sm text-muted">
          <template v-if="workspace.updateAvailable">A newer L4 release is available.</template>
          <template v-else>This workspace runs the latest release.</template>
          <template v-if="!workspace.linked"> Updating also links it to this Admin, so its domains, email, and Live no longer depend on llll.gg.</template>
        </p>
        <ProgressList v-if="busy === 'update'" class="mt-4" :steps="[{ id: 'release', label: 'Deploy the new release' }]" :state="updateSteps" />
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton v-if="workspace.updateAvailable" label="Update" :loading="busy === 'update'" :disabled="Boolean(busy)" @click="update" />
          <UButton v-if="!workspace.linked && !workspace.updateAvailable" label="Link to this Admin" :loading="busy === 'link'" :disabled="Boolean(busy)" @click="link" />
        </div>
      </section>

      <section v-if="data?.ownerSetupRequired" class="rounded-lg border border-default p-5">
        <h2 class="font-semibold text-highlighted">Owner setup</h2>
        <p class="mt-1 text-sm text-muted">Nobody has claimed this workspace yet. A new private link invalidates the previous one.</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton label="Generate setup link" :loading="busy === 'owner'" @click="ownerSetup" />
          <UButton v-if="setupUrl" :to="setupUrl" external target="_blank" label="Open private setup" trailing-icon="i-ph-arrow-up-right" color="neutral" variant="outline" />
        </div>
      </section>

      <section class="rounded-lg border border-default p-5">
        <h2 class="font-semibold text-highlighted">Domains and email</h2>
        <p class="mt-1 text-sm text-muted">Connect them from the workspace's own Workspace Settings → Cloudflare. The Admin applies the changes.</p>
        <UAlert v-if="data?.domains && 'error' in data.domains" class="mt-4" color="warning" :title="data.domains.error" />
        <ul v-else-if="domains" class="mt-4 space-y-1 text-sm">
          <li><span class="text-muted">App domain:</span> {{ domains.appDomain?.hostname || 'workers.dev address' }}</li>
          <li v-for="domain in domains.emailDomains" :key="domain.id">
            <span class="text-muted">Email:</span> {{ domain.domain }}
            <UBadge v-if="!domain.sendingEnabled" label="Cannot send" color="warning" variant="subtle" size="sm" class="ms-1" />
          </li>
        </ul>
      </section>

      <section class="rounded-lg border border-default p-5">
        <h2 class="font-semibold text-highlighted">Files and backups</h2>
        <p v-if="workspace.filesEnabled" class="mt-1 text-sm text-muted">R2 is connected. Attachments, uploaded avatars, and workspace backups are available.</p>
        <template v-else>
          <UAlert class="mt-3" color="warning" title="R2 is not connected" description="This workspace works without file storage. Attachments, uploaded avatars, and workspace backups are disabled." />
          <p class="mt-3 text-sm text-muted">Enable an R2 subscription in your Cloudflare account, then connect it here. R2 includes free monthly usage; additional usage is billed by Cloudflare.</p>
          <div class="mt-4 flex flex-wrap gap-2">
            <UButton :to="`https://dash.cloudflare.com/${session?.accountId || ''}/r2/overview`" target="_blank" label="Enable R2 in Cloudflare" color="neutral" variant="outline" trailing-icon="i-ph-arrow-up-right" />
            <UButton label="Connect R2" :loading="busy === 'files'" :disabled="Boolean(busy)" @click="enableFiles" />
          </div>
        </template>
      </section>

      <section class="rounded-lg border border-default p-5">
        <h2 class="font-semibold text-highlighted">Live</h2>
        <p class="mt-1 text-sm text-muted">
          Calls and live sessions use a RealtimeKit app the Admin creates for this workspace, with host and participant presets.
          <template v-if="data?.live.provisioned"> App <span class="font-mono text-xs">{{ data.live.appId }}</span>.</template>
        </p>
        <UButton v-if="!data?.live.provisioned" class="mt-4" label="Set up Live now" size="sm" :loading="busy === 'live'" @click="provisionLive" />
      </section>

      <section class="rounded-lg border border-error/40 p-5">
        <h2 class="font-semibold text-highlighted">Delete workspace</h2>
        <p class="mt-1 text-sm text-muted">Start deletion from the workspace's Workspace Settings → Danger zone; it sends you here with a one-time authorization.</p>
        <UButton class="mt-4" label="Delete…" color="error" variant="soft" size="sm" @click="deleteOpen = true" />
      </section>
    </div>

    <UModal v-model:open="deleteOpen" title="Delete workspace" description="This removes the Worker, its database, files, and connected domains.">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Deletion authorization" help="From Workspace Settings → Danger zone.">
            <UInput v-model="deleteClaim" class="w-full font-mono" />
          </UFormField>
          <UFormField :label="`Type ${workspace?.origin} to confirm`">
            <UInput v-model="deleteConfirmation" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="ghost" @click="deleteOpen = false" />
        <UButton label="Delete workspace" color="error" :loading="busy === 'delete'" :disabled="deleteConfirmation.trim() !== workspace?.origin || !deleteClaim.trim()" @click="remove" />
      </template>
    </UModal>
  </AdminShell>
</template>
