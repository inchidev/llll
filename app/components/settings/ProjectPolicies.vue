<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ProjectPolicy } from '~~/shared/project-access'
import { PermissionGrants } from '~~/shared/permissions'
const groupDefinitions = [
  { label: 'Server & members', keys: ['manageServer', 'manageRoles', 'invite', 'kick'] },
  { label: 'Chat & live', keys: ['manageChannels', 'sendMessages', 'attachFiles', 'startLive'] },
  { label: 'Projects & tasks', keys: ['readProjects', 'manageProjects', 'readTasks', 'writeTasks', 'manageTasks', 'delegateTasks', 'executeTasks', 'proposeCode'] },
  { label: 'Agents & compute', keys: ['useAgents', 'manageAgents', 'approveAgentActions', 'useComputer', 'browseWeb'] },
  { label: 'Data & apps', keys: ['readData', 'writeData', 'manageDatabases', 'useGadgets', 'manageGadgets'] },
  { label: 'Email', keys: ['readMail', 'sendMail'] },
  { label: 'Tools & integrations', keys: ['useExternalTools', 'mcp.connect'] },
  { label: 'Schedules', keys: ['manageSchedules'] },
]
const assignedKeys = new Set(groupDefinitions.flatMap(group => group.keys))
const permissionGroups = [
  ...groupDefinitions.map(group => ({ label: group.label, grants: PermissionGrants.filter(grant => group.keys.includes(grant.key)) })),
  { label: 'Other permissions', grants: PermissionGrants.filter(grant => !assignedKeys.has(grant.key)) },
].filter(group => group.grants.length)
const props = defineProps<{ serverId: string; isOwner?: boolean }>()
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const open = ref(false), busy = ref(false), editing = ref<ProjectPolicy | null>(null)
const deleteOpen = ref(false)
const systemPolicy = computed(() => Boolean(editing.value?.id.startsWith('server-policy-')))
const form = reactive({ name: '', description: '', permissions: 0 })
const query = useQuery({ queryKey: computed(() => ['project-policies', props.serverId]), queryFn: () => api<{ policies: ProjectPolicy[] }>(`/api/servers/${props.serverId}/project-policies`) })
function edit(policy: ProjectPolicy | null) { editing.value = policy; Object.assign(form, { name: policy?.name ?? '', description: policy?.description ?? '', permissions: policy?.permissions ?? 0 }); open.value = true }
defineExpose({ createPolicy: () => edit(null) })
function toggle(flag: number, enabled: boolean) { form.permissions = enabled ? form.permissions | flag : form.permissions & ~flag }
async function save() {
  busy.value = true
  try {
    await api(editing.value ? `/api/project-policies/${editing.value.id}` : `/api/servers/${props.serverId}/project-policies`, { method: editing.value ? 'PATCH' : 'POST', body: { ...form, ...(editing.value ? { version: editing.value.version } : {}) } })
    open.value = false; await query.refetch(); await cache.invalidateQueries({ queryKey: ['project-access'] }); await cache.invalidateQueries({ queryKey: ['members', props.serverId] }); await cache.invalidateQueries({ queryKey: ['roles', props.serverId] })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
async function remove() {
  if (!editing.value || busy.value) return
  busy.value = true
  try {
    await api(`/api/project-policies/${editing.value.id}`, { method: 'DELETE' })
    deleteOpen.value = false; open.value = false
    await cache.invalidateQueries({ queryKey: ['project-policies', props.serverId] })
    await cache.invalidateQueries({ queryKey: ['role-policies'] })
    await cache.invalidateQueries({ queryKey: ['roles', props.serverId] })
    await cache.invalidateQueries({ queryKey: ['project-access'] })
    await cache.invalidateQueries({ queryKey: ['members', props.serverId] })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <div class="space-y-6">
    <LayoutLoadError v-if="query.error.value" message="Project policies did not load." :retry="query.refetch" />
    <SettingsList :items="query.data.value?.policies ?? []" :item-key="policy => policy.id" :search-text="policy => `${policy.name} ${policy.description}`" :loading="query.isPending.value" placeholder="Search policies" :noun="['policy', 'policies']" @select="edit">
      <template #row="{ item: policy }">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-shield-check" class="size-4" /></span>
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ policy.name }}</span><span class="block text-xs text-muted">{{ policy.description }}</span></span>
      </template>
      <template #empty><p class="text-sm text-muted">No policies yet.</p></template>
    </SettingsList>
    <SettingsEditor v-model:open="open" back="Roles &amp; Policies" :title="editing ? 'Edit policy' : 'Create policy'" description="Changes apply wherever this policy is assigned.">
      <template #body><form class="space-y-5" @submit.prevent="save">
        <p v-if="systemPolicy" class="text-sm text-muted">This built-in policy cannot be edited.</p>
        <UFormField label="Name"><UInput v-model="form.name" :disabled="systemPolicy" required maxlength="80" class="w-full" /></UFormField>
        <UFormField label="Description"><UTextarea v-model="form.description" :disabled="systemPolicy" maxlength="2000" class="w-full" /></UFormField>
        <div class="space-y-6"><h2 class="font-medium">Permissions</h2><fieldset v-for="group in permissionGroups" :key="group.label" class="space-y-3"><legend class="mb-3 text-sm font-semibold text-highlighted">{{ group.label }}</legend><UCheckbox v-for="grant in group.grants" :key="grant.key" :label="grant.label" :description="grant.description" :disabled="systemPolicy" :model-value="Boolean(form.permissions & grant.flag)" @update:model-value="toggle(grant.flag, Boolean($event))" /></fieldset></div>
        <div class="flex justify-between gap-2"><UButton v-if="editing && !systemPolicy && isOwner" label="Delete" color="error" variant="ghost" :disabled="busy" @click="deleteOpen = true" /><span v-else /><div class="flex gap-2"><UButton label="Close" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton v-if="!systemPolicy" type="submit" label="Save policy" :loading="busy" :disabled="!form.name.trim()" /></div></div>
      </form></template>
    </SettingsEditor>
    <UModal v-model:open="deleteOpen" title="Delete policy" description="This removes the policy from every role and project where it is assigned.">
      <template #body><div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="deleteOpen = false" /><UButton label="Delete policy" color="error" :loading="busy" @click="remove" /></div></template>
    </UModal>
  </div>
</template>
