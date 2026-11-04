<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ServerDomainSettingsDTO, ServerManagementStatusDTO } from '~~/shared/releases'

const props = withDefaults(defineProps<{ serverId: string, view?: 'overview' | 'domains' }>(), { view: 'overview' })
const { api } = useApi()
const toast = useToast()
const managementQ = useQuery({
  queryKey: computed(() => ['server-deployment', props.serverId]),
  queryFn: () => api<ServerManagementStatusDTO>(`/api/servers/${props.serverId}/management`),
})
const domainsQ = useQuery({
  queryKey: computed(() => ['server-origins', props.serverId]),
  queryFn: () => api<ServerDomainSettingsDTO>(`/api/servers/${props.serverId}/domains`),
  enabled: computed(() => props.view === 'domains'),
})
const status = computed(() => managementQ.data.value)
const domains = computed(() => domainsQ.data.value)
const hostname = ref('')
const makePrimary = ref(false)
const busy = ref(false)
const addOpen = ref(false)
const pending = computed(() => domains.value?.pending.filter(item => item.status === 'pending' || item.status === 'running') ?? [])
const recent = computed(() => domains.value?.pending.filter(item => item.status === 'complete' || item.status === 'failed').slice(0, 3) ?? [])
let poll: ReturnType<typeof setInterval> | undefined

function stopPolling() {
  if (poll) clearInterval(poll)
  poll = undefined
}
function startPolling() {
  stopPolling()
  if (pending.value.length) poll = setInterval(() => { void domainsQ.refetch() }, 4000)
}
watch(pending, startPolling, { immediate: true })
onUnmounted(stopPolling)

async function request(action: 'add' | 'remove' | 'primary', target: string, primary = false) {
  if (busy.value) return
  busy.value = true
  // With Cloudflare access kept here the Server makes the change itself; no installer window.
  const direct = domains.value?.direct === true
  const popup = import.meta.client && !direct ? window.open('', '_blank') : null
  try {
    const response = await api<{ launchUrl?: string, applied?: boolean }>(`/api/servers/${props.serverId}/domains/request`, {
      method: 'POST',
      body: { action, hostname: target, ...(action === 'add' && primary ? { makePrimary: true } : {}) },
    })
    if (response.applied) popup?.close()
    else if (response.launchUrl && popup) {
      popup.opener = null
      popup.location.href = response.launchUrl
    }
    else if (response.launchUrl && import.meta.client) window.location.href = response.launchUrl
    hostname.value = ''
    makePrimary.value = false
    addOpen.value = false
    toast.add(response.applied
      ? { title: action === 'add' ? 'Address added' : action === 'primary' ? 'Primary address changed' : 'Address removed', color: 'success' }
      : { title: 'Continue in the Cloudflare window', description: 'Authorize Cloudflare once to make this change.', color: 'success' })
    await domainsQ.refetch()
    startPolling()
  }
  catch (error) {
    popup?.close()
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    busy.value = false
  }
}

async function add() {
  const target = hostname.value.trim().toLowerCase()
  if (!target) return
  await request('add', target, makePrimary.value)
}
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
      <UAlert v-if="view !== 'domains'" class="mt-6" color="neutral" title="Configured by the server operator" description="Manage domain routing and deployment credentials through your Cloudflare account or VPS configuration. Server settings contain this server's backups and optional provider connections." />
    </template>

    <template v-if="view === 'domains'">
      <section class="mt-8 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="font-medium text-highlighted">Addresses</h2>
            <p class="mt-1 text-sm text-muted">Every listed address works for login, links and MCP. Adding one never disables the others.</p>
          </div>
          <UButton v-if="domains?.managed" label="Add address" icon="i-ph-plus" size="sm" :disabled="busy" @click="addOpen = !addOpen" />
        </div>
        <LayoutSkeleton v-if="domainsQ.isPending.value" variant="rows" />
        <LayoutLoadError v-else-if="domainsQ.error.value" message="Server addresses did not load." :retry="domainsQ.refetch" />
        <template v-else-if="domains">
          <ul class="divide-y divide-default rounded-lg border border-default">
            <li v-for="item in domains.origins" :key="item.origin" class="flex min-w-0 flex-wrap items-center gap-3 p-4">
              <div class="min-w-0 flex-1">
                <p class="break-all font-medium">{{ item.hostname }}</p>
                <p class="break-all text-xs text-muted">{{ item.origin }}</p>
              </div>
              <UBadge v-if="item.primary" color="primary" variant="subtle">Primary</UBadge>
              <template v-else-if="domains.managed && !item.hostname.endsWith('.workers.dev')">
                <UButton label="Make primary" size="sm" color="neutral" variant="ghost" :disabled="busy" @click="request('primary', item.hostname)" />
                <UButton label="Remove" size="sm" color="error" variant="ghost" :disabled="busy" @click="request('remove', item.hostname)" />
              </template>
              <UBadge v-else-if="item.hostname.endsWith('.workers.dev')" color="neutral" variant="subtle">Always available</UBadge>
            </li>
          </ul>

          <form v-if="addOpen && domains.managed" class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="add">
            <UFormField label="Domain" description="A hostname in a Cloudflare zone you control, for example inchi.example.com.">
              <UInput v-model="hostname" placeholder="inchi.example.com" autocomplete="off" class="w-full" :disabled="busy" />
            </UFormField>
            <UCheckbox v-model="makePrimary" label="Make this the primary address" :disabled="busy" />
            <p class="text-xs text-muted">The current primary stays available as an alias. Background email and links use the primary.</p>
            <div class="flex flex-wrap gap-2">
              <UButton type="submit" :label="domains.direct ? 'Add address' : 'Continue to Cloudflare'" icon="i-ph-cloud" :loading="busy" :disabled="!hostname.trim()" />
              <UButton label="Cancel" color="neutral" variant="ghost" :disabled="busy" @click="addOpen = false" />
            </div>
          </form>

          <template v-if="!domains.managed">
            <UAlert color="neutral" title="Operator-managed addresses" description="This Server runs outside the Cloudflare installer. Add and remove addresses with the Server operator CLI." />
            <div class="rounded-lg border border-default bg-elevated/40 p-4 text-sm">
              <p class="font-medium">VPS</p>
              <pre class="mt-2 overflow-x-auto text-xs text-muted">sudo llll domain add &lt;host&gt;
sudo llll domain primary &lt;host&gt;
sudo llll domain remove &lt;host&gt;</pre>
              <p class="mt-2 text-xs text-muted">Caddy obtains TLS for every address. The primary cannot be removed.</p>
            </div>
          </template>

          <div v-if="pending.length || recent.length" class="space-y-2">
            <p class="text-xs font-medium uppercase tracking-wide text-muted">Requests</p>
            <div v-for="item in [...pending, ...recent]" :key="item.id" class="flex flex-wrap items-center gap-2 rounded-lg border border-default px-3 py-2 text-sm">
              <UIcon :name="item.status === 'complete' ? 'i-ph-check-circle' : item.status === 'failed' ? 'i-ph-x-circle' : 'i-ph-circle-notch'" class="size-4" :class="item.status === 'pending' || item.status === 'running' ? 'animate-spin' : ''" />
              <span class="min-w-0 flex-1 break-all">{{ item.action === 'add' ? 'Add' : item.action === 'primary' ? 'Make primary' : 'Remove' }} {{ item.hostname }}</span>
              <UBadge :color="item.status === 'complete' ? 'success' : item.status === 'failed' ? 'error' : 'neutral'" variant="subtle">{{ item.status }}</UBadge>
              <p v-if="item.error" class="w-full text-xs text-error">{{ item.error }}</p>
            </div>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
