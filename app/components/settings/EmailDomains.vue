<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ServerDomainSettingsDTO } from '~~/shared/releases'
import type { MailSettingsDTO } from '~~/shared/types'

const props = defineProps<{
  serverId: string
  isOwner: boolean
  mail: MailSettingsDTO
}>()
const { api } = useApi()
const qc = useQueryClient(), toast = useToast()
// With Cloudflare access kept on this Server, the Owner connects mail domains here.
const domainsQ = useQuery({
  queryKey: computed(() => ['server-origins', props.serverId]),
  queryFn: () => api<ServerDomainSettingsDTO>(`/api/servers/${props.serverId}/domains`),
  enabled: computed(() => props.isOwner),
})
const direct = computed(() => props.isOwner && domainsQ.data.value?.direct === true)
const zones = computed(() => domainsQ.data.value?.zones ?? [])
const adding = ref(false), zoneId = ref(''), domain = ref(''), busy = ref('')
watch(zones, value => { if (!zoneId.value && value[0]) { zoneId.value = value[0].id; domain.value ||= value[0].name } }, { immediate: true })
watch(zoneId, id => { const zone = zones.value.find(item => item.id === id); if (zone && !domain.value.endsWith(zone.name)) domain.value = zone.name })

function mailboxCount(name: string) {
  const suffix = `@${name.toLowerCase()}`
  return props.mail.mailboxes.filter(mailbox => mailbox.address.toLowerCase().endsWith(suffix)).length
}
async function changed() { await Promise.all([qc.invalidateQueries({ queryKey: ['mail-settings', props.serverId] }), domainsQ.refetch()]) }
async function connect() {
  if (busy.value || !zoneId.value || !domain.value.trim()) return
  busy.value = 'connect'
  try {
    const connected = await api<{ domain: string; sendingEnabled?: boolean }>(`/api/servers/${props.serverId}/email-domains`, { method: 'POST', body: { zoneId: zoneId.value, domain: domain.value.trim().toLowerCase() } })
    toast.add(connected.sendingEnabled === false
      ? { title: `${connected.domain} receives mail`, description: 'Cloudflare has not enabled sending yet. Connect it again later to finish.', color: 'warning' }
      : { title: `${connected.domain} connected`, color: 'success' })
    adding.value = false
    await changed()
  }
  catch (error) { toast.add({ title: 'The mail domain was not connected', description: errorMessage(error), color: 'error' }) }
  finally { busy.value = '' }
}
async function remove(id: string) {
  if (busy.value) return
  busy.value = id
  try { await api(`/api/servers/${props.serverId}/email-domains/${id}`, { method: 'DELETE' }); await changed() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = '' }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-muted">Domains this server sends and receives mail on.</p>
      <UButton v-if="direct && !adding" label="Connect domain" icon="i-ph-plus" size="sm" @click="adding = true" />
    </div>
    <form v-if="adding" class="mt-3 space-y-3 rounded-lg border border-default p-4" @submit.prevent="connect">
      <UFormField label="Cloudflare zone"><USelect v-model="zoneId" :items="zones.map(zone => ({ label: zone.name, value: zone.id }))" class="w-full" :disabled="Boolean(busy)" /></UFormField>
      <UFormField label="Mail domain" description="The zone itself or a subdomain, for example mail.example.com."><UInput v-model="domain" autocomplete="off" class="w-full" :disabled="Boolean(busy)" /></UFormField>
      <p class="text-xs text-muted">This turns on Cloudflare Email Routing and Email Sending for the domain and routes its mail to this Server.</p>
      <div class="flex gap-2"><UButton type="submit" label="Connect" :loading="busy === 'connect'" :disabled="!zoneId || !domain.trim()" /><UButton label="Cancel" color="neutral" variant="ghost" @click="adding = false" /></div>
    </form>
    <div v-if="!mail.domains.length && !adding" class="mt-3 rounded-lg border border-dashed border-default px-4 py-8 text-center">
      <UIcon name="i-ph-globe-simple" class="size-6 text-dimmed" />
      <p class="mt-2 text-sm font-medium text-highlighted">No email domains yet</p>
      <p class="mt-1 text-sm text-muted">{{ direct ? 'Connect a domain from a Cloudflare zone in this account.' : 'Ask the server operator to configure an email domain.' }}</p>
    </div>
    <ul v-else-if="mail.domains.length" class="mt-3 divide-y divide-default overflow-hidden rounded-lg border border-default">
      <li v-for="item in mail.domains" :key="item.id" class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
          <UIcon name="i-ph-globe-simple" class="size-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium text-highlighted">{{ item.domain }}</span>
          <span class="block truncate text-xs text-muted">{{ mailboxCount(item.domain) }} {{ mailboxCount(item.domain) === 1 ? 'mailbox' : 'mailboxes' }}</span>
        </span>
        <UButton v-if="direct" label="Disconnect" size="sm" color="neutral" variant="ghost" :loading="busy === item.id" :disabled="Boolean(busy)" @click="remove(item.id)" />
      </li>
    </ul>
    <p v-if="!direct" class="mt-3 text-sm text-muted">Email domains are managed by the server operator, or here once this Server keeps Cloudflare access (Settings → Deployment → Updates).</p>
  </div>
</template>
