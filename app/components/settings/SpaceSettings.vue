<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { SpaceAdminRow, SpaceDTO, SpaceQuotaField, SpaceQuotas, SpaceRole } from '~~/shared/spaces'
import type { MemberDTO, UserKind } from '~~/shared/types'
import { formatBytes } from '~~/shared/format'

type SpaceUsage = { storageBytes: number; members: number; agents: number; runs: number; emails: number; voice: number }
type SpaceMember = { id: string; displayName: string; kind: UserKind; role: SpaceRole }

const props = defineProps<{ serverId: string; isOwner: boolean; canManageServer: boolean; members: MemberDTO[] }>()
const { api } = useApi()
const toast = useToast()
const qc = useQueryClient()
const { spacesQ, spaces } = useSpaces(() => props.serverId)

/** Without Manage server, a Space admin sees only the Spaces they run. */
const visible = computed(() => props.isOwner || props.canManageServer ? spaces.value : spaces.value.filter(space => space.role === 'admin'))
const selectedId = ref<string | null>(null)
// The Owner opens Spaces from the table, which reaches further than the list a Member's Client loads.
const opened = ref<SpaceAdminRow | null>(null)
const selected = computed<SpaceDTO | null>(() => visible.value.find(space => space.id === selectedId.value) ?? (opened.value?.id === selectedId.value ? opened.value : null))
function openFromTable(space: SpaceAdminRow) { opened.value = space; selectedId.value = space.id }
const canManageMembers = computed(() => props.isOwner || selected.value?.role === 'admin')
const base = (spaceId: string) => `/api/servers/${props.serverId}/spaces/${spaceId}`

const usageQ = useQuery({
  queryKey: computed(() => ['space-usage', props.serverId, selectedId.value]),
  queryFn: () => api<{ usage: SpaceUsage }>(`${base(selectedId.value!)}/usage`),
  enabled: computed(() => Boolean(selected.value) && canManageMembers.value),
})
const spaceMembersQ = useQuery({
  queryKey: computed(() => ['space-members', props.serverId, selectedId.value]),
  queryFn: () => api<{ members: SpaceMember[] }>(`${base(selectedId.value!)}/members`),
  enabled: computed(() => Boolean(selected.value) && canManageMembers.value),
})

const roleItems = [{ label: 'Member', value: 'member' }, { label: 'Space admin', value: 'admin' }]
const MEBIBYTE = 1024 * 1024
const limitFields: { key: SpaceQuotaField; label: string; bytes?: boolean }[] = [
  { key: 'storageLimitBytes', label: 'Storage (MB)', bytes: true },
  { key: 'memberLimit', label: 'Members' },
  { key: 'agentLimit', label: 'Agents' },
  { key: 'monthlyRunLimit', label: 'Runs per month' },
  { key: 'monthlyEmailLimit', label: 'Emails per month' },
  { key: 'monthlyVoiceLimit', label: 'Voice minutes per month' },
]
const usageRows = computed(() => {
  const usage = usageQ.data.value?.usage
  if (!usage) return []
  const quotas = selected.value?.quotas
  const row = (label: string, used: number, limit: number | null | undefined, format: (value: number) => string = String) => ({ label, value: limit == null ? format(used) : `${format(used)} of ${format(limit)}` })
  return [
    row('Storage', usage.storageBytes, quotas?.storageLimitBytes, formatBytes),
    row('Members', usage.members, quotas?.memberLimit),
    row('Agents', usage.agents, quotas?.agentLimit),
    row('Runs this month', usage.runs, quotas?.monthlyRunLimit),
    row('Emails this month', usage.emails, quotas?.monthlyEmailLimit),
    row('Voice minutes this month', usage.voice, quotas?.monthlyVoiceLimit),
  ]
})

const createOpen = ref(false)
const createForm = reactive({ name: '', description: '' })
const form = reactive({ name: '', description: '' })
const limits = reactive<Record<string, string | number>>({})
const busy = ref('')
const newMemberId = ref<string>()
const newMemberRole = ref<SpaceRole>('member')
const deleteOpen = ref(false)
const deleteError = ref('')

const candidates = computed(() => {
  const taken = new Set(spaceMembersQ.data.value?.members.map(member => member.id))
  return props.members
    .filter(member => member.user.kind === 'human' && !taken.has(member.user.id))
    .map(member => ({ label: member.nickname || member.user.displayName, value: member.user.id }))
})

function limitText(field: typeof limitFields[number], quotas: SpaceDTO['quotas']) {
  const value = quotas?.[field.key]
  if (value == null) return ''
  return field.bytes ? String(value / MEBIBYTE) : String(value)
}
watch(() => selected.value?.id, () => {
  const space = selected.value
  form.name = space?.name ?? ''
  form.description = space?.description ?? ''
  for (const field of limitFields) limits[field.key] = limitText(field, space?.quotas)
  newMemberId.value = undefined
  newMemberRole.value = 'member'
}, { immediate: true })
const formChanged = computed(() => Boolean(selected.value && form.name.trim() && (form.name.trim() !== selected.value.name || form.description.trim() !== selected.value.description)))

/** A row in the open editor comes from the table, so a change there has to reach what is shown. */
async function refreshSpaces() {
  await Promise.all([qc.invalidateQueries({ queryKey: ['spaces', props.serverId] }), qc.invalidateQueries({ queryKey: ['space-admin', props.serverId] })])
}
function changedSpace(space: SpaceDTO) { if (opened.value?.id === space.id) opened.value = { ...opened.value, ...space } }
async function refreshMembers(spaceId: string) {
  await Promise.all([
    refreshSpaces(),
    qc.invalidateQueries({ queryKey: ['space-members', props.serverId, spaceId] }),
    qc.invalidateQueries({ queryKey: ['space-usage', props.serverId, spaceId] }),
  ])
}
/** Runs one change at a time and reports its failure; `busy` names the control that is working. */
async function run(key: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = key
  try { await action() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = '' }
}

const create = () => run('create', async () => {
  const name = createForm.name.trim()
  if (!name) return
  const { space } = await api<{ space: SpaceDTO }>(`/api/servers/${props.serverId}/spaces`, { method: 'POST', body: { name, description: createForm.description.trim() } })
  await refreshSpaces()
  createOpen.value = false
  createForm.name = ''
  createForm.description = ''
  selectedId.value = space.id
})
const saveDetails = () => run('details', async () => {
  await api(base(selectedId.value!), { method: 'PATCH', body: { name: form.name.trim(), description: form.description.trim() } })
  await refreshSpaces()
  toast.add({ title: 'Space saved', color: 'success' })
})
const saveLimits = () => run('limits', async () => {
  const body = {} as SpaceQuotas
  for (const field of limitFields) {
    const text = String(limits[field.key] ?? '').trim()
    const value = text === '' ? null : Number(text)
    if (value !== null && (!Number.isFinite(value) || value < 0 || (!field.bytes && !Number.isInteger(value)))) {
      toast.add({ title: `${field.label}: enter a whole number, or leave it empty for no limit`, color: 'error' })
      return
    }
    body[field.key] = value !== null && field.bytes ? Math.round(value * MEBIBYTE) : value
  }
  changedSpace((await api<{ space: SpaceDTO }>(`${base(selectedId.value!)}/limits`, { method: 'PUT', body })).space)
  await refreshSpaces()
  toast.add({ title: 'Limits saved', color: 'success' })
})
const resetLimits = () => run('reset', async () => {
  const { space } = await api<{ space: SpaceDTO }>(`${base(selectedId.value!)}/limits`, { method: 'PUT', body: { reset: true } })
  changedSpace(space)
  for (const field of limitFields) limits[field.key] = limitText(field, space.quotas)
  await refreshSpaces()
  toast.add({ title: 'Limits removed', color: 'success' })
})
const suspendOpen = ref(false)
const setSuspended = (suspended: boolean) => run('suspend', async () => {
  const { space } = await api<{ space: SpaceDTO }>(`${base(selectedId.value!)}/suspension`, { method: 'PUT', body: { suspended } })
  changedSpace(space)
  suspendOpen.value = false
  await refreshSpaces()
  toast.add({ title: suspended ? 'Space suspended' : 'Space resumed', color: 'success' })
})
const join = () => run('join', async () => {
  await api(`${base(selectedId.value!)}/join`, { method: 'POST' })
  await refreshMembers(selectedId.value!)
  toast.add({ title: `You joined ${selected.value?.name ?? 'the Space'}`, color: 'success' })
})
const addMember = () => run('add', async () => {
  if (!newMemberId.value) return
  await api(`${base(selectedId.value!)}/members`, { method: 'POST', body: { userId: newMemberId.value, role: newMemberRole.value } })
  await refreshMembers(selectedId.value!)
  newMemberId.value = undefined
  newMemberRole.value = 'member'
})
const setRole = (member: SpaceMember, role: SpaceRole) => run(`role:${member.id}`, async () => {
  await api(`${base(selectedId.value!)}/members/${member.id}`, { method: 'PATCH', body: { role } })
  await refreshMembers(selectedId.value!)
})
const removeMember = (member: SpaceMember) => run(`remove:${member.id}`, async () => {
  await api(`${base(selectedId.value!)}/members/${member.id}`, { method: 'DELETE' })
  await refreshMembers(selectedId.value!)
})
function askDelete() { deleteError.value = ''; deleteOpen.value = true }
/** The refusal stays in the dialog: it says what still has to leave this Space. */
async function deleteSpace() {
  if (busy.value) return
  busy.value = 'delete'
  deleteError.value = ''
  try {
    await api(base(selectedId.value!), { method: 'DELETE' })
    deleteOpen.value = false
    selectedId.value = null
    await refreshSpaces()
    toast.add({ title: 'Space deleted', color: 'success' })
  }
  catch (error) { deleteError.value = errorMessage(error) }
  finally { busy.value = '' }
}
</script>

<template>
  <section>
    <SettingsHeader title="Spaces" description="Spaces separate departments of one organization. Each Space has its own Members, channels, Projects and Agents, and Members see only the Spaces they belong to.">
      <template #actions><UButton v-if="canManageServer || isOwner" icon="i-ph-plus" label="Create Space" @click="createOpen = true" /></template>
    </SettingsHeader>
    <LayoutLoadError v-if="spacesQ.error.value" class="mt-6" message="Spaces did not load." :retry="spacesQ.refetch" />
    <SettingsSpacesTable v-if="isOwner" class="mt-6" :server-id="serverId" @open="openFromTable" />
    <SettingsList v-else class="mt-6" :items="visible" :loading="spacesQ.isPending.value" :item-key="space => space.id" :search-text="space => space.name" placeholder="Search Spaces" :noun="['Space', 'Spaces']" @select="selectedId = $event.id">
      <template #row="{ item: space }">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-buildings" class="size-4" /></span>
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ space.name }}</span><span class="block truncate text-xs text-muted">{{ space.memberCount }} {{ space.memberCount === 1 ? 'member' : 'members' }}<template v-if="space.isDefault"> · Default</template><template v-if="space.role === 'admin'"> · Space admin</template><template v-else-if="!space.role"> · Not joined</template></span></span>
      </template>
      <template #empty><p class="text-sm text-muted">No Spaces to manage.</p></template>
    </SettingsList>

    <SettingsEditor v-model:open="createOpen" back="Spaces" title="Create Space" :dismissible="busy !== 'create'">
      <template #body>
        <form class="space-y-4" @submit.prevent="create">
          <UFormField label="Name"><UInput v-model="createForm.name" autofocus maxlength="80" class="w-full" /></UFormField>
          <UFormField label="Description"><UTextarea v-model="createForm.description" maxlength="500" :rows="2" class="w-full" /></UFormField>
          <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="ghost" @click="createOpen = false" /><UButton type="submit" label="Create Space" :loading="busy === 'create'" :disabled="!createForm.name.trim()" /></div>
        </form>
      </template>
    </SettingsEditor>

    <SettingsEditor back="Spaces" :open="Boolean(selected)" :title="selected?.name || 'Space'" :description="selected?.isDefault ? 'The default Space' : undefined" @update:open="value => { if (!value) selectedId = null }">
      <template #body>
        <div v-if="selected" class="space-y-8">
          <section v-if="isOwner && !selected.role" class="rounded-lg border border-default p-4">
            <h2 class="text-sm font-semibold text-highlighted">Join this Space</h2>
            <p class="mt-1 text-sm text-muted">You manage this Space without being in it. Joining is what lets you read its contents, and it is recorded in the audit log.</p>
            <UButton class="mt-3" label="Join" size="sm" :loading="busy === 'join'" @click="join" />
          </section>

          <form v-if="isOwner" class="space-y-4" @submit.prevent="saveDetails">
            <UFormField label="Name"><UInput v-model="form.name" maxlength="80" class="w-full" /></UFormField>
            <UFormField label="Description"><UTextarea v-model="form.description" maxlength="500" :rows="2" class="w-full" /></UFormField>
            <div class="flex justify-end"><UButton type="submit" label="Save" :loading="busy === 'details'" :disabled="!formChanged" /></div>
          </form>
          <p v-else-if="selected.description" class="text-sm text-default">{{ selected.description }}</p>

          <section v-if="canManageMembers" class="space-y-3">
            <h2 class="text-sm font-semibold text-highlighted">Usage</h2>
            <LayoutLoadError v-if="usageQ.error.value" message="Usage did not load." :retry="usageQ.refetch" />
            <LayoutSkeleton v-else-if="usageQ.isPending.value" variant="rows" :rows="2" />
            <dl v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <div v-for="row in usageRows" :key="row.label" class="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"><dt class="text-muted">{{ row.label }}</dt><dd class="text-highlighted">{{ row.value }}</dd></div>
            </dl>
          </section>

          <form v-if="isOwner" class="space-y-3" @submit.prevent="saveLimits">
            <div>
              <h2 class="text-sm font-semibold text-highlighted">Limits</h2>
              <p class="mt-1 text-sm text-muted">Leave a field empty for no limit.</p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField v-for="field in limitFields" :key="field.key" :label="field.label"><UInput v-model="limits[field.key]" type="number" min="0" :step="field.bytes ? 'any' : '1'" class="w-full" /></UFormField>
            </div>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <UButton label="Remove limits" color="neutral" variant="ghost" :loading="busy === 'reset'" @click="resetLimits" />
              <UButton type="submit" label="Save limits" :loading="busy === 'limits'" />
            </div>
          </form>

          <section v-if="canManageMembers" class="space-y-3">
            <div>
              <h2 class="text-sm font-semibold text-highlighted">Members</h2>
              <p class="mt-1 text-sm text-muted">A Space admin manages this Space's members and its content, and can invite people into it.</p>
            </div>
            <LayoutLoadError v-if="spaceMembersQ.error.value" message="Members did not load." :retry="spaceMembersQ.refetch" />
            <LayoutSkeleton v-else-if="spaceMembersQ.isPending.value" variant="rows" :rows="3" />
            <ul v-else-if="spaceMembersQ.data.value?.members.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="member in spaceMembersQ.data.value.members" :key="member.id" class="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ member.displayName }}<span v-if="member.kind === 'agent'" class="ms-2 text-xs font-normal text-muted">Agent</span></span>
                <USelect :model-value="member.role" :items="roleItems" :disabled="Boolean(busy)" :loading="busy === `role:${member.id}`" :aria-label="`Space role of ${member.displayName}`" class="w-36" @update:model-value="value => { if (value !== member.role) setRole(member, value as SpaceRole) }" />
                <UButton icon="i-ph-x" color="neutral" variant="ghost" square :disabled="Boolean(busy)" :loading="busy === `remove:${member.id}`" :aria-label="`Remove ${member.displayName} from this Space`" @click="removeMember(member)" />
              </li>
            </ul>
            <p v-else class="text-sm text-muted">No members yet.</p>
            <form class="flex flex-wrap items-center gap-2" @submit.prevent="addMember">
              <USelectMenu v-model="newMemberId" :items="candidates" value-key="value" placeholder="Choose a Member" aria-label="Member to add" class="min-w-48 flex-1" />
              <USelect v-model="newMemberRole" :items="roleItems" aria-label="Space role" class="w-36" />
              <UButton type="submit" label="Add" :loading="busy === 'add'" :disabled="!newMemberId" />
            </form>
          </section>

          <section v-if="isOwner && !selected.isDefault" class="rounded-lg border border-default p-4">
            <p class="text-sm font-medium text-highlighted">{{ selected.suspended ? 'This Space is suspended' : 'Suspend Space' }}</p>
            <p class="mt-1 text-sm text-muted">{{ selected.suspended ? 'Nobody but you can use it. Nothing in it is lost.' : 'Nobody but you can use it until you resume it. Nothing in it is lost.' }}</p>
            <UButton v-if="selected.suspended" class="mt-3" size="sm" label="Resume Space" :loading="busy === 'suspend'" @click="setSuspended(false)" />
            <UButton v-else class="mt-3" color="warning" variant="soft" size="sm" label="Suspend Space" @click="suspendOpen = true" />
          </section>

          <section v-if="isOwner && !selected.isDefault" class="rounded-lg border border-default p-4">
            <p class="text-sm font-medium text-highlighted">Delete Space</p>
            <p class="mt-1 text-sm text-muted">A Space can be deleted once it holds nothing.</p>
            <UButton class="mt-3" color="error" variant="soft" size="sm" label="Delete Space" @click="askDelete" />
          </section>
        </div>
      </template>
    </SettingsEditor>

    <UModal v-model:open="suspendOpen" title="Suspend this Space?" :dismissible="busy !== 'suspend'">
      <template #body><p class="text-sm text-muted">{{ selected?.name }} stops working for everyone in it until you resume it. Nothing in it is lost.</p></template>
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" :disabled="busy === 'suspend'" @click="suspendOpen = false" />
        <UButton color="warning" label="Suspend Space" :loading="busy === 'suspend'" @click="setSuspended(true)" />
      </template>
    </UModal>

    <UModal v-model:open="deleteOpen" title="Delete this Space?" :dismissible="busy !== 'delete'">
      <template #body>
        <p class="text-sm text-muted">{{ selected?.name }} will be removed for everyone in it.</p>
        <p v-if="deleteError" class="mt-3 text-sm text-error" role="alert">{{ deleteError }}</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" :disabled="busy === 'delete'" @click="deleteOpen = false" />
        <UButton color="error" label="Delete Space" :loading="busy === 'delete'" @click="deleteSpace" />
      </template>
    </UModal>
  </section>
</template>
