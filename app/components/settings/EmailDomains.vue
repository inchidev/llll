<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MailSettingsDTO } from '~~/shared/types'
import type { InstallationDomainSettingsDTO } from '~~/shared/releases'

/**
 * Email Domains live where people look for them: next to the mailboxes that
 * use them. Only the owner can connect or disconnect; everyone else sees the list.
 */
const props = defineProps<{
  workspaceId: string
  isOwner: boolean
  mail: MailSettingsDTO
}>()

const { api } = useApi()
const qc = useQueryClient()
const toast = useToast()

const domainsQ = useQuery({
  queryKey: computed(() => ['installation-domains', props.workspaceId]),
  queryFn: () => api<InstallationDomainSettingsDTO>(`/api/workspaces/${props.workspaceId}/domains`),
  enabled: computed(() => props.isOwner),
  staleTime: 5 * 60_000,
})
const managed = computed(() => domainsQ.data.value?.managed ?? false)
const zones = computed(() => (domainsQ.data.value?.zones ?? []).filter(zone => zone.status === 'active'))

type Row = { id: string | null, domain: string, zoneId: string | null, detail: string, cannotSend: boolean }
const rows = computed<Row[]>(() => {
  const connected = domainsQ.data.value?.emailDomains
  if (props.isOwner && connected) {
    return connected.map(domain => ({
      id: domain.id,
      domain: domain.domain,
      zoneId: domain.zoneId,
      detail: domain.zoneName === domain.domain ? '' : `in ${domain.zoneName}`,
      cannotSend: domain.sendingEnabled === false,
    }))
  }
  return props.mail.domains.map(domain => ({ id: null, domain: domain.domain, zoneId: null, detail: '', cannotSend: false }))
})

function mailboxCount(domain: string) {
  const suffix = `@${domain.toLowerCase()}`
  return props.mail.mailboxes.filter(mailbox => mailbox.address.toLowerCase().endsWith(suffix)).length
}

async function refresh() {
  await Promise.all([
    domainsQ.refetch(),
    qc.invalidateQueries({ queryKey: ['mail-settings', props.workspaceId] }),
    qc.invalidateQueries({ queryKey: ['installation-management', props.workspaceId] }),
  ])
}

// Add
const addOpen = ref(false)
const adding = ref(false)
const label = ref('')
const zoneId = ref('')
const input = ref<{ hostname: string } | null>(null)
watch(zones, (list) => {
  if (!list.some(zone => zone.id === zoneId.value)) zoneId.value = list[0]?.id ?? ''
}, { immediate: true })
const labelValid = computed(() => !label.value.trim() || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label.value.trim()))
const alreadyConnected = computed(() => {
  const hostname = input.value?.hostname
  return Boolean(hostname && rows.value.some(row => row.domain.toLowerCase() === hostname))
})
const fieldError = computed(() => {
  if (!labelValid.value) return 'Use letters, numbers and hyphens, like mail'
  if (alreadyConnected.value) return `${input.value?.hostname} is already connected`
  return undefined
})

async function addDomain() {
  const domain = input.value?.hostname
  if (!domain || fieldError.value) return
  adding.value = true
  try {
    await api(`/api/workspaces/${props.workspaceId}/email-domains`, { method: 'POST', body: { zoneId: zoneId.value, domain } })
    await refresh()
    toast.add({ title: `${domain} connected`, color: 'success' })
    addOpen.value = false
    label.value = ''
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { adding.value = false }
}

// The Email settings header shows Add domain beside New mailbox, so both actions sit in one place.
const canAdd = computed(() => props.isOwner && managed.value && zones.value.length > 0)
defineExpose({ canAdd, openAdd: () => { addOpen.value = true } })

// Repair: connecting a domain again finishes a setup that left it unable to send.
const repairing = ref<string | null>(null)
async function repairSending(row: Row) {
  if (!row.zoneId) return
  repairing.value = row.domain
  try {
    const result = await api<{ sendingEnabled?: boolean }>(`/api/workspaces/${props.workspaceId}/email-domains`, {
      method: 'POST',
      body: { zoneId: row.zoneId, domain: row.domain },
    })
    await refresh()
    if (result.sendingEnabled === false) toast.add({ title: `${row.domain} still cannot send`, description: 'Cloudflare has not finished enabling Email Sending. Try again in a few minutes.', color: 'warning' })
    else toast.add({ title: `${row.domain} can send mail`, color: 'success' })
  }
  catch (error) { toast.add({ title: `Sending was not repaired for ${row.domain}`, description: errorMessage(error), color: 'error' }) }
  finally { repairing.value = null }
}

// Disconnect
const removing = ref<Row | null>(null)
const removeBusy = ref(false)
async function disconnect() {
  const row = removing.value
  if (!row?.id) return
  removeBusy.value = true
  try {
    await api(`/api/workspaces/${props.workspaceId}/email-domains/${row.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: `${row.domain} disconnected`, color: 'success' })
    removing.value = null
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { removeBusy.value = false }
}
</script>

<template>
  <div>
    <p class="text-sm text-muted">
      {{ isOwner ? 'Domains this workspace sends and receives mail on.' : 'Only the workspace owner can add or remove email domains.' }}
    </p>

    <LayoutSkeleton v-if="isOwner && domainsQ.isPending.value" variant="rows" :rows="2" class="mt-3 -mx-2" />
    <LayoutLoadError v-else-if="isOwner && domainsQ.error.value" message="Email domains did not load." :retry="domainsQ.refetch" />
    <div v-else-if="!rows.length" class="mt-3 rounded-lg border border-dashed border-default px-4 py-8 text-center">
      <UIcon name="i-ph-globe-simple" class="size-6 text-dimmed" />
      <p class="mt-2 text-sm font-medium text-highlighted">No email domains yet</p>
      <p class="mt-1 text-sm text-muted">Add a domain to create addresses like support@example.com.</p>
    </div>
    <ul v-else class="mt-3 divide-y divide-default overflow-hidden rounded-lg border border-default">
      <li v-for="row in rows" :key="row.domain" class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
          <UIcon name="i-ph-globe-simple" class="size-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium text-highlighted">{{ row.domain }}</span>
          <span class="block truncate text-xs text-muted">
            {{ mailboxCount(row.domain) }} {{ mailboxCount(row.domain) === 1 ? 'mailbox' : 'mailboxes' }}<template v-if="row.detail"> · {{ row.detail }}</template>
          </span>
          <span v-if="row.cannotSend" class="mt-0.5 flex items-center gap-1 text-xs text-warning">
            <UIcon name="i-ph-warning" class="size-3.5 shrink-0" />
            Receives mail but cannot send it
          </span>
        </span>
        <UButton
          v-if="isOwner && row.cannotSend"
          label="Repair sending"
          color="warning"
          variant="soft"
          size="sm"
          :loading="repairing === row.domain"
          :disabled="Boolean(repairing) && repairing !== row.domain"
          @click="repairSending(row)"
        />
        <template v-if="isOwner && row.id">
          <!-- A domain with mailboxes cannot be disconnected; say why instead of showing a dead button. -->
          <UTooltip v-if="mailboxCount(row.domain)" text="Delete its mailboxes to disconnect this domain.">
            <span class="flex items-center gap-1 text-xs text-dimmed">
              <UIcon name="i-ph-lock-simple" class="size-3.5" />
              In use
            </span>
          </UTooltip>
          <UButton v-else label="Disconnect" color="neutral" variant="ghost" size="sm" @click="removing = row" />
        </template>
      </li>
    </ul>
    <p v-if="isOwner && !domainsQ.isPending.value && !managed" class="mt-3 text-sm text-muted">
      This workspace was deployed from the repository. Add email domains in its deployment configuration.
    </p>

    <UModal v-model:open="addOpen" title="Add email domain" description="Mail for this domain is routed to this workspace.">
      <template #body>
        <UFormField label="Domain" :error="fieldError">
          <SettingsDomainInput
            ref="input"
            v-model:label="label"
            v-model:zone-id="zoneId"
            :zones="zones"
            allow-apex
            placeholder="mail"
            :example="hostname => `Addresses will look like name@${hostname}`"
          />
        </UFormField>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="addOpen = false" />
        <UButton label="Add domain" :loading="adding" :disabled="!zoneId || Boolean(fieldError)" @click="addDomain" />
      </template>
    </UModal>

    <UModal
      :open="Boolean(removing)"
      :title="`Disconnect ${removing?.domain ?? ''}?`"
      @update:open="(value: boolean) => { if (!value) removing = null }"
    >
      <template #body>
        <p class="text-sm text-muted">This workspace stops sending and receiving mail on this domain. You can add it again later.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="removing = null" />
        <UButton color="error" label="Disconnect" :loading="removeBusy" @click="disconnect" />
      </template>
    </UModal>
  </div>
</template>
