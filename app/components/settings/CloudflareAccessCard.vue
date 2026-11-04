<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { formatDateTime } from '~~/shared/format'

type AccessState = { available: boolean; accountId: string | null; access: { connected: false } | { connected: true; kind: 'oauth' | 'token'; accountId: string; connectedAt: string } }
const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const qc = useQueryClient(), toast = useToast()
const access = useQuery({ queryKey: computed(() => ['cloudflare-account', props.serverId]), queryFn: () => api<AccessState>(`/api/servers/${props.serverId}/cloudflare-account`) })
const pasting = ref(false), token = ref(''), busy = ref(false)
// Cloudflare pre-fills an account token with exactly what an update needs.
const tokenUrl = computed(() => {
  const keys = [
    { key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' }, { key: 'workers_r2', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' }, { key: 'account_settings', type: 'read' },
  ]
  const account = access.data.value?.accountId
  return account ? `https://dash.cloudflare.com/?to=/${account}/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&name=${encodeURIComponent('L4 Server updates')}` : ''
})
async function done() { await Promise.all([access.refetch(), qc.invalidateQueries({ queryKey: ['update-progress', props.serverId] })]) }
async function save() {
  if (busy.value || !token.value.trim()) return
  busy.value = true
  try { await api(`/api/servers/${props.serverId}/cloudflare-account`, { method: 'PUT', body: { token: token.value.trim() } }); token.value = ''; pasting.value = false; await done() }
  catch (error) { toast.add({ title: 'Cloudflare was not connected', description: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function disconnect() {
  if (busy.value) return
  busy.value = true
  try { await api(`/api/servers/${props.serverId}/cloudflare-account`, { method: 'DELETE' }); await done() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
defineExpose({ connected: computed(() => access.data.value?.access.connected === true) })
</script>

<template>
  <section v-if="access.data.value?.available" class="space-y-2 rounded-lg border border-default p-4" aria-label="Cloudflare access">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2"><UIcon name="i-ph-cloud" class="size-4 shrink-0" /><h2 class="text-sm font-medium text-highlighted">Cloudflare access</h2></div>
      <UBadge :label="access.data.value.access.connected ? 'Connected' : 'Not connected'" :color="access.data.value.access.connected ? 'success' : 'neutral'" variant="subtle" size="sm" />
    </div>
    <div v-if="access.data.value.access.connected" class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-muted">{{ access.data.value.access.kind === 'oauth' ? 'Kept from the official installer' : 'API token' }} · since {{ formatDateTime(access.data.value.access.connectedAt) }}. Used for updates, domains, mail and Live.</p>
      <UButton label="Disconnect" size="sm" color="neutral" variant="ghost" :loading="busy" @click="disconnect" />
    </div>
    <template v-else>
      <p class="text-sm text-muted">Keep Cloudflare access on this Server to update it from here, without the official installer. For safety, run each Server in its own Cloudflare account; a free account is enough.</p>
      <div v-if="pasting" class="space-y-2">
        <ol class="list-decimal space-y-1 ps-5 text-sm">
          <li><a :href="tokenUrl" target="_blank" rel="noopener noreferrer" class="underline">Create a token in Cloudflare</a>. Its permissions are filled in; select Create.</li>
          <li>Copy the token and paste it here.</li>
        </ol>
        <UInput v-model="token" type="password" autocomplete="off" placeholder="Cloudflare API token" class="w-full" aria-label="Cloudflare API token" @keydown.enter.prevent="save" />
        <div class="flex gap-2"><UButton label="Connect" :disabled="token.trim().length < 20" :loading="busy" @click="save" /><UButton label="Cancel" color="neutral" variant="ghost" @click="pasting = false" /></div>
      </div>
      <UButton v-else label="Connect with an API token" color="neutral" variant="outline" @click="pasting = true" />
    </template>
  </section>
</template>
