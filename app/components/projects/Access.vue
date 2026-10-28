<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ProjectPolicyPermissions, type ProjectAssignment, type ProjectPolicy } from '~~/shared/project-access'
import type { MemberDTO, RoleDTO } from '~~/shared/types'
const props = defineProps<{ projectId: string }>()
const { api } = useApi(), { serverId } = useServer(), toast = useToast(), cache = useQueryClient()
const open = ref(false), busy = ref(false), editing = ref<ProjectAssignment | null>(null), policyId = ref(''), target = ref(''), kind = ref('member'), search = ref('')
const query = useQuery({ queryKey: computed(() => ['project-access', props.projectId]), queryFn: () => api<{ assignments: ProjectAssignment[]; policies: ProjectPolicy[]; canManage: boolean }>(`/api/projects/${props.projectId}/access`) })
const members = useQuery({ queryKey: computed(() => ['members', serverId.value]), queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${serverId.value}/members`), enabled: computed(() => open.value && Boolean(query.data.value?.canManage)) })
const roles = useQuery({ queryKey: computed(() => ['roles', serverId.value]), queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${serverId.value}/roles`), enabled: computed(() => open.value && Boolean(query.data.value?.canManage)) })
const targets = computed(() => kind.value === 'member' ? (members.data.value?.members ?? []).map(m => ({ value: m.user.id, label: `${m.nickname || m.user.displayName}${m.user.kind === 'agent' ? ' · Agent' : ''}` })) : (roles.data.value?.roles ?? []).filter(r => r.key !== 'owner').map(r => ({ value: r.id, label: r.name })))
const visible = computed(() => (query.data.value?.assignments ?? []).filter(a => `${a.name} ${a.policyName}`.toLowerCase().includes(search.value.toLowerCase())))
watch(kind, () => { if (!editing.value) target.value = '' })
function edit(assignment: ProjectAssignment | null) { editing.value = assignment; kind.value = assignment?.roleId ? 'role' : 'member'; target.value = assignment?.memberId ?? assignment?.roleId ?? ''; policyId.value = assignment?.policyId ?? ''; open.value = true }
async function refresh() { await query.refetch(); await cache.invalidateQueries({ queryKey: ['members', serverId.value] }); await cache.invalidateQueries({ queryKey: ['projects'] }); await cache.invalidateQueries({ queryKey: ['project'] }) }
async function save() {
  busy.value = true
  try {
    await api(`/api/projects/${props.projectId}/access${editing.value ? '/' + editing.value.id : ''}`, { method: editing.value ? 'PATCH' : 'POST', body: editing.value ? { policyId: policyId.value } : { policyId: policyId.value, ...(kind.value === 'member' ? { memberId: target.value } : { roleId: target.value }) } })
    open.value = false; await refresh()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
async function revoke() {
  if (!editing.value) return
  busy.value = true
  try { await api(`/api/projects/${props.projectId}/access/${editing.value.id}`, { method: 'DELETE' }); open.value = false; await refresh() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-medium">Project access</h3><p class="mt-1 text-sm text-muted">People and agents can have different permissions in each project. Their Server role stays the same.</p></div><UButton v-if="query.data.value?.canManage" label="Assign access" icon="i-ph-plus" color="neutral" variant="outline" @click="edit(null)" /></div>
    <LayoutLoadError v-if="query.error.value" message="Project access did not load." :retry="query.refetch" />
    <UInput v-if="query.data.value?.assignments.length" v-model="search" aria-label="Search project access" placeholder="Search members and policies" class="w-full" />
    <div class="divide-y divide-default rounded-lg border border-default"><div v-for="assignment in visible" :key="assignment.id" class="flex flex-wrap items-center justify-between gap-3 p-4"><div><p class="font-medium">{{ assignment.name }}</p><p class="text-xs text-muted">{{ assignment.kind === 'role' ? 'Server role' : assignment.kind === 'agent' ? 'Agent' : 'Person' }}</p></div><div class="flex items-center gap-3"><UBadge :label="assignment.policyName" color="neutral" variant="subtle" /><UButton v-if="query.data.value?.canManage" label="Edit access" color="neutral" variant="ghost" @click="edit(assignment)" /></div></div></div>
    <p v-if="!query.isPending.value && !visible.length" class="text-sm text-muted">No project policies assigned. Existing Server role permissions still apply.</p>
    <UModal v-model:open="open" :title="editing ? 'Edit project access' : 'Assign project access'" description="This assignment applies only to this project. Policies add permissions; a read-only policy does not remove broader rights already granted elsewhere.">
      <template #body><form class="space-y-5" @submit.prevent="save">
        <template v-if="!editing"><UFormField label="Assign to"><USelect v-model="kind" :items="[{ label: 'Person or agent', value: 'member' }, { label: 'Server role', value: 'role' }]" class="w-full" /></UFormField><UFormField :label="kind === 'member' ? 'Member' : 'Server role'"><USelectMenu v-model="target" :items="targets" value-key="value" placeholder="Choose a participant" class="w-full" /></UFormField></template>
        <p v-else class="font-medium">{{ editing.name }}</p>
        <UFormField label="Policy"><USelect v-model="policyId" :items="(query.data.value?.policies ?? []).filter(p => (p.permissions & ~ProjectPolicyPermissions) === 0).map(p => ({ label: p.name, value: p.id }))" placeholder="Choose permissions" class="w-full" /></UFormField>
        <p class="text-sm text-muted">{{ query.data.value?.policies.find(p => p.id === policyId)?.description }}</p>
        <div class="flex flex-wrap justify-between gap-2"><UButton v-if="editing" label="Remove assignment" color="error" variant="ghost" :loading="busy" @click="revoke" /><span v-else /><div class="flex gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Save access" :loading="busy" :disabled="!policyId || (!editing && !target)" /></div></div>
      </form></template>
    </UModal>
  </section>
</template>
