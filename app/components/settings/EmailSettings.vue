<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MailSettingsDTO, MailboxPermission, MemberDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string }>()
const toast = useToast()
const qc = useQueryClient()
const { api } = useApi()
const tab = ref<'mailboxes' | 'domains'>('mailboxes')
/** The Domains panel; its owner-only Add domain action shows in this page's header. */
const createOpen = ref(false)
const deleteOpen = ref(false)
const accessQuery = ref('')
const selectedId = ref<string | null>(null)
const localPart = ref('')
const domainId = ref('')
const displayName = ref('')
const creating = ref(false)
const saving = ref(false)
const deleting = ref(false)
const enabled = ref(true)
const grants = reactive<Record<string, 'none' | MailboxPermission>>({})

const mailQ = useQuery({
  queryKey: computed(() => ['mail-settings', props.serverId]),
  queryFn: () => api<{ mail: MailSettingsDTO }>(`/api/servers/${props.serverId}/mail`),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${props.serverId}/members`),
})
const mail = computed(() => mailQ.data.value?.mail)
const mailboxes = computed(() => mail.value?.mailboxes ?? [])
const domains = computed(() => mail.value?.domains ?? [])
const domainOptions = computed(() => domains.value.map(domain => ({ label: domain.domain, value: domain.id })))
const selected = computed(() => mailboxes.value.find(mailbox => mailbox.channelId === selectedId.value) ?? null)
const ownerId = computed(() => membersQ.data.value?.members.find(member => member.role.key === 'owner')?.user.id ?? null)
const { mine } = usePermissions(computed(() => membersQ.data.value?.members))
const isOwner = computed(() => mine.value?.role.key === 'owner')
const session = useSessionStore()
const inboundUnavailable = computed(() => session.health?.capabilities.emailInbound === null)
const outboundDescription = computed(() => {
  const provider = session.health?.capabilities.emailProvider
  const inbound = 'Mail from the internet does not arrive until you set INBOUND_EMAIL_SECRET, or a Postmark, Mailgun, or Amazon SES webhook secret.'
  if (provider === 'cloudflare-rest') return `${inbound} Outbound mail uses Cloudflare Email Sending. The sender domain must be onboarded for Email Sending.`
  if (provider === 'binding') return `${inbound} Outbound mail uses the email binding configured for this server.`
  if (provider === 'gateway' || provider === 'smtp') return `${inbound} Outbound mail uses the configured HTTP gateway. An SMTP gateway is an HTTP service that relays the same JSON message over SMTP.`
  return `${inbound} Outbound mail sends through Cloudflare Email Sending when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set, or through MAIL_GATEWAY_URL or SMTP_GATEWAY_URL with its token.`
})
// With no domain yet there is nothing to create a mailbox on, so start where the fix is.
watch(() => mail.value?.configured, (configured) => {
  if (configured === false) tab.value = 'domains'
}, { immediate: true })
const permissionOptions = [
  { label: 'No access', value: 'none' },
  { label: 'Read only', value: 'read' },
  { label: 'Read and send', value: 'send' },
  { label: 'Manage', value: 'manage' },
]

// No selection shows the mailbox list; a deleted mailbox drops back to it.
watch(mailboxes, (items) => {
  if (selectedId.value && !items.some(item => item.channelId === selectedId.value)) selectedId.value = null
})

watch(domains, (items) => {
  if (!items.some(item => item.id === domainId.value)) domainId.value = items[0]?.id ?? ''
}, { immediate: true })

function resetDraft() {
  const mailbox = selected.value
  displayName.value = mailbox?.displayName || ''
  enabled.value = mailbox?.enabled ?? true
  for (const key of Object.keys(grants)) grants[key] = 'none'
  for (const member of membersQ.data.value?.members ?? []) grants[member.user.id] = 'none'
  for (const access of mailbox?.access ?? []) grants[access.userId] = access.permission
}
watch(selected, resetDraft, { immediate: true })

const members = computed(() => membersQ.data.value?.members ?? [])
const filteredMembers = computed(() => {
  const term = accessQuery.value.trim().toLocaleLowerCase()
  if (!term) return members.value
  return members.value.filter(member => (member.nickname || member.user.displayName).toLocaleLowerCase().includes(term))
})
const dirty = computed(() => {
  const mailbox = selected.value
  if (!mailbox) return false
  if (displayName.value.trim() !== (mailbox.displayName || '') || enabled.value !== mailbox.enabled) return true
  const saved = new Map(mailbox.access.map(access => [access.userId, access.permission]))
  return Object.entries(grants).some(([userId, permission]) => (saved.get(userId) ?? 'none') !== permission)
})
const grantedCount = (mailbox: MailSettingsDTO['mailboxes'][number]) => mailbox.access.length

function openMailbox(mailbox: MailSettingsDTO['mailboxes'][number]) {
  selectedId.value = mailbox.channelId
  accessQuery.value = ''
}

watch(() => membersQ.data.value?.members, (members) => {
  for (const member of members ?? []) if (!(member.user.id in grants)) grants[member.user.id] = 'none'
}, { immediate: true })

function accessPayload() {
  return Object.entries(grants)
    .filter((entry): entry is [string, MailboxPermission] => entry[1] !== 'none')
    .map(([userId, permission]) => ({ userId, permission }))
}

async function createMailbox() {
  if (!localPart.value.trim() || !domainId.value) return
  creating.value = true
  try {
    await api(`/api/servers/${props.serverId}/mailboxes`, {
      method: 'POST',
      body: { domainId: domainId.value, localPart: localPart.value, displayName: localPart.value, access: [] },
    })
    localPart.value = ''
    createOpen.value = false
    await Promise.all([
      mailQ.refetch(),
      qc.invalidateQueries({ queryKey: ['mailboxes'] }),
    ])
    toast.add({ title: 'Mailbox created', color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { creating.value = false }
}

async function deleteMailbox() {
  if (!selected.value) return
  deleting.value = true
  try {
    await api(`/api/servers/${props.serverId}/mailboxes/${selected.value.channelId}`, { method: 'DELETE' })
    deleteOpen.value = false
    selectedId.value = null
    await Promise.all([
      mailQ.refetch(),
      qc.invalidateQueries({ queryKey: ['mailboxes'] }),
    ])
    toast.add({ title: 'Mailbox deleted', color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { deleting.value = false }
}

async function saveMailbox() {
  if (!selected.value || !displayName.value.trim()) return
  saving.value = true
  try {
    await api(`/api/servers/${props.serverId}/mailboxes/${selected.value.channelId}`, {
      method: 'PATCH',
      body: { displayName: displayName.value.trim(), enabled: enabled.value, access: accessPayload() },
    })
    await Promise.all([
      mailQ.refetch(),
      qc.invalidateQueries({ queryKey: ['mailboxes'] }),
    ])
    toast.add({ title: 'Mailbox updated', color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}
</script>

<template>
  <div>
    <template v-if="!selected">
      <SettingsHeader title="Email" description="Addresses on your email domains. Mail arrives in the Mail app for everyone with access.">
        <template #actions>
          <UButton
            v-if="mail?.configured && tab === 'mailboxes'"
            icon="i-ph-plus"
            label="New mailbox"
            size="sm"
            :disabled="!domains.length"
            @click="createOpen = true"
          />
        </template>
      </SettingsHeader>

      <LayoutSkeleton v-if="mailQ.isPending.value" variant="rows" class="mt-6 -mx-2" />
      <LayoutLoadError v-else-if="mailQ.error.value" message="Email settings did not load." :retry="mailQ.refetch" />
      <template v-else-if="mail">
        <LayoutSegmentedTabs
          v-model="tab"
          :items="[
            { value: 'mailboxes', label: 'Mailboxes', count: mailboxes.length },
            { value: 'domains', label: 'Domains', count: domains.length },
          ]"
          label="Email settings"
          class="mt-5"
        />
        <UAlert
          v-if="inboundUnavailable"
          color="neutral"
          variant="subtle"
          title="Inbound email is not configured"
          :description="outboundDescription"
          class="mt-5"
        />
        <UAlert
          v-if="mail.configured && !mail.sendingBound"
          color="warning"
          title="Sending is not set up yet"
          description="Mail can be received, but this server cannot send until its email domain finishes connecting."
          class="mt-5"
        />

        <SettingsList
          v-if="tab === 'mailboxes'"
          class="mt-5"
          :items="mailboxes"
          :item-key="mailbox => mailbox.channelId"
          :search-text="mailbox => `${mailbox.address} ${mailbox.displayName ?? ''}`"
          placeholder="Search mailboxes"
          :noun="['mailbox', 'mailboxes']"
          @select="openMailbox"
        >
          <template #empty>
            <div class="rounded-lg border border-dashed border-default px-4 py-8 text-center">
              <UIcon name="i-ph-envelope-simple" class="size-6 text-dimmed" />
              <p class="mt-2 text-sm font-medium text-highlighted">No mailboxes yet</p>
              <template v-if="domains.length">
                <p class="mt-1 text-sm text-muted">Create an address like support@ to start receiving mail.</p>
                <UButton class="mt-4" size="sm" icon="i-ph-plus" label="New mailbox" @click="createOpen = true" />
              </template>
              <template v-else>
                <p class="mt-1 text-sm text-muted">Mailboxes need an email domain first.</p>
                <UButton class="mt-4" size="sm" color="neutral" variant="soft" label="Go to Domains" @click="tab = 'domains'" />
              </template>
            </div>
          </template>
          <template #row="{ item: mailbox }">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
              <UIcon name="i-ph-envelope-simple" class="size-4" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-highlighted">{{ mailbox.address }}</span>
              <span class="block truncate text-xs text-muted">
                {{ mailbox.displayName || 'No display name' }} · {{ grantedCount(mailbox) }} with access
              </span>
            </span>
            <UBadge :label="mailbox.enabled ? 'Active' : 'Paused'" :color="mailbox.enabled ? 'success' : 'neutral'" variant="subtle" size="sm" />
          </template>
        </SettingsList>

        <SettingsEmailDomains v-else class="mt-5" :server-id="serverId" :is-owner="isOwner" :mail="mail" />
      </template>
    </template>

    <template v-else>
      <SettingsHeader :title="selected.address" back="Mailboxes" @back="selectedId = null">
        <template #badge>
          <UBadge :label="selected.enabled ? 'Active' : 'Paused'" :color="selected.enabled ? 'success' : 'neutral'" variant="subtle" size="sm" />
        </template>
      </SettingsHeader>

      <section class="mt-6 space-y-5">
        <UFormField label="Display name" help="Shown as the sender name on outgoing mail.">
          <UInput v-model="displayName" class="w-full max-w-md" />
        </UFormField>
        <div class="flex items-start justify-between gap-6 rounded-lg border border-default px-4 py-3">
          <div>
            <p class="text-sm font-medium text-highlighted">Receive email</p>
            <p class="mt-0.5 text-xs text-muted">When paused, new mail is not accepted and the mailbox is hidden from Mail. Nothing is deleted.</p>
          </div>
          <USwitch v-model="enabled" aria-label="Receive email" />
        </div>
      </section>

      <section class="mt-8">
        <h2 class="text-[11px] font-bold uppercase tracking-wide text-muted">Access</h2>
        <UInput
          v-if="members.length >= 6"
          v-model="accessQuery"
          icon="i-ph-magnifying-glass"
          placeholder="Search members"
          aria-label="Search members"
          class="mt-2 w-full"
        />
        <ul class="mt-2 divide-y divide-default rounded-lg border border-default">
          <li v-for="member in filteredMembers" :key="member.user.id" class="flex items-center gap-3 px-4 py-2.5">
            <UserAvatar :user="member.user" size="sm" />
            <span class="min-w-0 flex-1 truncate text-sm text-default">{{ member.nickname || member.user.displayName }}</span>
            <USelect
              v-model="grants[member.user.id]"
              :items="permissionOptions"
              value-key="value"
              size="sm"
              class="w-36"
              :disabled="member.user.id === ownerId"
              :aria-label="`Access for ${member.nickname || member.user.displayName}`"
            />
          </li>
        </ul>
      </section>

      <div class="mt-8 rounded-lg border border-error/30 p-4">
        <p class="text-sm font-medium text-highlighted">Delete mailbox</p>
        <p class="mt-1 text-sm text-muted">Removes the address and its conversations.</p>
        <UButton class="mt-3" color="error" variant="soft" size="sm" label="Delete mailbox" @click="deleteOpen = true" />
      </div>

      <LayoutSaveBar :dirty="dirty" :saving="saving" :disabled="!displayName.trim()" @save="saveMailbox" @reset="resetDraft" />
    </template>

    <UModal v-model:open="createOpen" title="New mailbox">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Address">
            <div class="flex items-center gap-2">
              <UInput v-model="localPart" placeholder="support" class="min-w-0 flex-1" autofocus @keyup.enter="createMailbox" />
              <span class="text-muted">@</span>
              <USelect v-model="domainId" :items="domainOptions" value-key="value" class="min-w-0 flex-1" aria-label="Email domain" />
            </div>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="createOpen = false" />
        <UButton label="Create mailbox" :loading="creating" :disabled="!localPart.trim() || !domainId" @click="createMailbox" />
      </template>
    </UModal>

    <UModal v-model:open="deleteOpen" title="Delete this mailbox?">
      <template #body>
        <p class="text-sm text-muted">{{ selected?.address }} and its conversations will be removed. This cannot be undone.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" @click="deleteOpen = false" />
        <UButton color="error" label="Delete mailbox" :loading="deleting" @click="deleteMailbox" />
      </template>
    </UModal>
  </div>
</template>
