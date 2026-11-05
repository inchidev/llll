<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CLOUDFLARE_DOMAINS_URL, type ServerDomainSettingsDTO } from '~~/shared/releases'
import type { MailSettingsDTO } from '~~/shared/types'

const props = defineProps<{
  serverId: string
  isOwner: boolean
  mail: MailSettingsDTO
}>()
const emit = defineEmits<{ connected: [id: string] }>()
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
const noDomainToConnect = computed(() => direct.value && !domainsQ.isPending.value && !zones.value.length)
/** Cloudflare has not enabled sending for it yet; connecting it again finishes the job. */
function sendingOff(id: string) {
  return domainsQ.data.value?.emailDomains?.find(item => item.id === id)?.sendingEnabled === false
}
const adding = ref(false), zoneId = ref(''), domain = ref(''), busy = ref('')
watch(zones, value => { if (!zoneId.value && value[0]) { zoneId.value = value[0].id; domain.value ||= value[0].name } }, { immediate: true })
watch(zoneId, id => { const zone = zones.value.find(item => item.id === id); if (zone && !domain.value.endsWith(zone.name)) domain.value = zone.name })

function mailboxCount(name: string) {
  const suffix = `@${name.toLowerCase()}`
  return props.mail.mailboxes.filter(mailbox => mailbox.address.toLowerCase().endsWith(suffix)).length
}
async function changed() { await Promise.all([qc.invalidateQueries({ queryKey: ['mail-settings', props.serverId] }), domainsQ.refetch()]) }
async function connect(target = { zoneId: zoneId.value, domain: domain.value.trim().toLowerCase() }, marker = 'connect') {
  if (busy.value || !target.zoneId || !target.domain) return
  busy.value = marker
  try {
    const connected = await api<{ id: string; domain: string; sendingEnabled?: boolean }>(`/api/servers/${props.serverId}/email-domains`, { method: 'POST', body: target })
    toast.add(connected.sendingEnabled === false
      ? { title: `${connected.domain} receives mail`, description: 'Cloudflare has not enabled sending yet. Select Finish connecting later.', color: 'warning' }
      : { title: `${connected.domain} connected`, color: 'success' })
    adding.value = false
    await changed()
    if (marker === 'connect' && !mailboxCount(connected.domain)) emit('connected', connected.id)
  }
  catch (error) { toast.add({ title: 'The mail domain was not connected', description: errorMessage(error), color: 'error' }) }
  finally { busy.value = '' }
}
function finish(id: string) {
  const item = domainsQ.data.value?.emailDomains?.find(row => row.id === id)
  if (item) return connect({ zoneId: item.zoneId, domain: item.domain }, `finish:${id}`)
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
      <UButton v-if="direct && !adding && zones.length" label="Connect domain" icon="i-ph-plus" size="sm" @click="adding = true" />
    </div>
    <div v-if="noDomainToConnect" class="mt-3 rounded-lg border border-default p-4">
      <p class="text-sm font-medium text-highlighted">This Cloudflare account has no active domain</p>
      <p class="mt-1 text-sm text-muted">Buy a domain in Cloudflare or add one you already own. It appears here once Cloudflare shows it as Active.</p>
      <UButton class="mt-3" label="Open Cloudflare domains" icon="i-ph-arrow-square-out" size="sm" color="neutral" variant="outline" :to="CLOUDFLARE_DOMAINS_URL" target="_blank" />
    </div>
    <form v-if="adding" class="mt-3 space-y-3 rounded-lg border border-default p-4" @submit.prevent="connect()">
      <UFormField label="Cloudflare domain"><USelect v-model="zoneId" :items="zones.map(zone => ({ label: zone.name, value: zone.id }))" class="w-full" :disabled="Boolean(busy)" /></UFormField>
      <UFormField label="Mail domain" description="The domain itself, or a subdomain such as mail.example.com if it already receives mail elsewhere."><UInput v-model="domain" autocomplete="off" class="w-full" :disabled="Boolean(busy)" /></UFormField>
      <p class="text-xs text-muted">Cloudflare will receive and send this domain's mail for this Server. The Server sets up the records itself.</p>
      <div class="flex gap-2"><UButton type="submit" label="Connect" :loading="busy === 'connect'" :disabled="!zoneId || !domain.trim()" /><UButton label="Cancel" color="neutral" variant="ghost" @click="adding = false" /></div>
    </form>
    <div v-if="!mail.domains.length && !adding && !noDomainToConnect" class="mt-3 rounded-lg border border-dashed border-default px-4 py-8 text-center">
      <UIcon name="i-ph-globe-simple" class="size-6 text-dimmed" />
      <p class="mt-2 text-sm font-medium text-highlighted">No email domains yet</p>
      <p class="mt-1 text-sm text-muted">{{ direct ? 'Connect a domain from this Cloudflare account.' : isOwner ? 'Keep Cloudflare access on this Server to connect a domain here (Settings → Deployment → Updates).' : 'Ask the Owner to connect an email domain.' }}</p>
    </div>
    <ul v-else-if="mail.domains.length" class="mt-3 divide-y divide-default overflow-hidden rounded-lg border border-default">
      <li v-for="item in mail.domains" :key="item.id" class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
          <UIcon name="i-ph-globe-simple" class="size-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium text-highlighted">{{ item.domain }}</span>
          <span class="block truncate text-xs text-muted">{{ mailboxCount(item.domain) }} {{ mailboxCount(item.domain) === 1 ? 'mailbox' : 'mailboxes' }}<template v-if="sendingOff(item.id)"> · Receives mail, sending is off</template></span>
        </span>
        <UButton v-if="direct && sendingOff(item.id)" label="Finish connecting" size="sm" color="neutral" variant="outline" :loading="busy === `finish:${item.id}`" :disabled="Boolean(busy)" @click="finish(item.id)" />
        <UButton v-if="direct" label="Disconnect" size="sm" color="neutral" variant="ghost" :loading="busy === item.id" :disabled="Boolean(busy)" @click="remove(item.id)" />
      </li>
    </ul>
    <p v-if="!direct && isOwner && mail.domains.length" class="mt-3 text-sm text-muted">Connect email domains here once this Server keeps Cloudflare access (Settings → Deployment → Updates).</p>
  </div>
</template>
