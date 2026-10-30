<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { AgentAccessDTO, AgentAccessGrant, AgentAccessMode } from '~~/shared/agent-access'
import { ProjectPolicyPermissions, type ProjectPolicy } from '~~/shared/project-access'
import type { Project } from '~~/shared/projects'
import type { MemberDTO, RoleDTO } from '~~/shared/types'
const props = defineProps<{ serverId: string; agentId: string; agentName: string }>()
// Select items cannot use an empty value, so the whole-Server scope has its own.
const SERVER = 'server'
const { api } = useApi(), toast = useToast(), session = useSessionStore()
const base = computed(() => `/api/servers/${props.serverId}/agents/${props.agentId}`)
const open = ref(false), busy = ref(false), removing = ref<AgentAccessGrant | null>(null)
const kind = ref<'member' | 'role'>('member'), target = ref(''), policyId = ref(''), projectId = ref(SERVER), dailyRuns = ref<number | null>(null), expiresOn = ref('')
const query = useQuery({ queryKey: computed(() => ['agent-access', props.serverId, props.agentId]), queryFn: () => api<AgentAccessDTO & { policies: ProjectPolicy[] }>(`${base.value}/access`) })
const members = useQuery({ queryKey: computed(() => ['members', props.serverId]), queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${props.serverId}/members`), enabled: open })
const roles = useQuery({ queryKey: computed(() => ['roles', props.serverId]), queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${props.serverId}/roles`), enabled: open })
const projects = useQuery({ queryKey: computed(() => ['projects', props.serverId]), queryFn: () => api<{ projects: Project[] }>(`/api/servers/${props.serverId}/projects`), enabled: open })
const targets = computed(() => kind.value === 'member'
  ? (members.data.value?.members ?? []).filter(m => m.user.kind === 'human' && m.user.id !== session.user?.id).map(m => ({ value: m.user.id, label: m.nickname || m.user.displayName }))
  : (roles.data.value?.roles ?? []).filter(r => r.key !== 'owner').map(r => ({ value: r.id, label: r.name })))
const scopes = computed(() => [{ value: SERVER, label: 'Whole Server' }, ...(projects.data.value?.projects ?? []).filter(p => !p.archivedAt).map(p => ({ value: p.id, label: p.name }))])
// A project grant carries only project permissions, as project assignments do.
const policies = computed(() => (query.data.value?.policies ?? []).filter(p => projectId.value === SERVER || (p.permissions & ~ProjectPolicyPermissions) === 0).map(p => ({ value: p.id, label: p.name })))
const modeItems = [
  { value: 'open', label: 'Everyone who uses agents', description: 'Others are limited to what they may do themselves.' },
  { value: 'granted', label: 'Only people with access below', description: 'Everyone else is ignored when they mention it.' },
]
watch(kind, () => { target.value = '' })
watch(projectId, () => { if (!policies.value.some(p => p.value === policyId.value)) policyId.value = '' })
function add() { kind.value = 'member'; target.value = ''; policyId.value = ''; projectId.value = SERVER; dailyRuns.value = null; expiresOn.value = ''; open.value = true }
async function setMode(access: AgentAccessMode) {
  busy.value = true
  try { await api(`${base.value}/access-mode`, { method: 'PUT', body: { access } }); await query.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
async function save() {
  busy.value = true
  try {
    await api(`${base.value}/access`, { method: 'POST', body: {
      policyId: policyId.value, ...(kind.value === 'member' ? { memberId: target.value } : { roleId: target.value }),
      projectId: projectId.value === SERVER ? null : projectId.value, dailyRuns: dailyRuns.value || null,
      expiresAt: expiresOn.value ? new Date(`${expiresOn.value}T23:59:59`).toISOString() : null,
    } })
    open.value = false; await query.refetch()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
async function revoke(grant: AgentAccessGrant) {
  removing.value = grant
  try { await api(`${base.value}/access/${grant.id}`, { method: 'DELETE' }); await query.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { removing.value = null }
}
function limits(grant: AgentAccessGrant) {
  return [grant.projectName ?? 'Whole Server', grant.dailyRuns ? `${grant.dailyRuns} runs a day` : '', grant.expiresAt ? `until ${new Date(grant.expiresAt).toLocaleDateString()}` : ''].filter(Boolean).join(' · ')
}
</script>
<template>
  <section class="space-y-4 border-t border-default pt-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div><h3 class="font-medium">Who can use {{ agentName }}</h3><p class="mt-1 text-sm text-muted">By default {{ agentName }} works with the permissions of the person who asks, never more than its own role. Access lets a person or role use it with more.</p></div>
      <UButton v-if="query.data.value" label="Give access" icon="i-ph-plus" color="neutral" variant="outline" @click="add" />
    </div>
    <LayoutLoadError v-if="query.error.value" message="Agent access did not load." :retry="query.refetch" />
    <UFormField v-if="query.data.value" label="Answers">
      <USelect :model-value="query.data.value.access" :items="modeItems" :disabled="busy" aria-label="Who the agent answers" class="w-full" @update:model-value="setMode($event as AgentAccessMode)" />
    </UFormField>
    <div v-if="query.data.value?.grants.length" class="divide-y divide-default rounded-lg border border-default">
      <div v-for="grant in query.data.value.grants" :key="grant.id" class="flex flex-wrap items-center justify-between gap-3 p-4">
        <div class="min-w-0"><p class="font-medium">{{ grant.name }}</p><p class="text-xs text-muted">{{ grant.kind === 'role' ? 'Server role' : 'Person' }} · {{ limits(grant) }}</p></div>
        <div class="flex items-center gap-3"><UBadge :label="grant.policyName" color="neutral" variant="subtle" /><UButton label="Remove" color="neutral" variant="ghost" :loading="removing?.id === grant.id" @click="revoke(grant)" /></div>
      </div>
    </div>
    <p v-else-if="query.data.value" class="text-sm text-muted">No one has extra access.</p>
    <UModal v-model:open="open" :title="`Give access to ${agentName}`" description="They can use the agent with this policy even where their own role allows less. You can only give permissions you have.">
      <template #body><form class="space-y-5" @submit.prevent="save">
        <UFormField label="Give to"><USelect v-model="kind" :items="[{ label: 'Person', value: 'member' }, { label: 'Server role', value: 'role' }]" class="w-full" /></UFormField>
        <UFormField :label="kind === 'member' ? 'Person' : 'Server role'"><USelectMenu v-model="target" :items="targets" value-key="value" placeholder="Choose" class="w-full" /></UFormField>
        <UFormField label="Where"><USelect v-model="projectId" :items="scopes" class="w-full" /></UFormField>
        <UFormField label="Policy" :description="query.data.value?.policies.find(p => p.id === policyId)?.description"><USelect v-model="policyId" :items="policies" placeholder="Choose permissions" class="w-full" /></UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Runs a day" description="Empty for no extra limit."><UInputNumber v-model="dailyRuns" :min="1" :max="10000" class="w-full" /></UFormField>
          <UFormField label="Until" description="Empty for no end date."><UInput v-model="expiresOn" type="date" class="w-full" /></UFormField>
        </div>
        <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Give access" :loading="busy" :disabled="!policyId || !target" /></div>
      </form></template>
    </UModal>
  </section>
</template>
