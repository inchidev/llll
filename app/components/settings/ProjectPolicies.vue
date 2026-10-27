<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ProjectPolicyGrants, type ProjectPolicy } from '~~/shared/project-access'
const props = defineProps<{ serverId: string }>()
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const search = ref(''), open = ref(false), busy = ref(false), editing = ref<ProjectPolicy | null>(null)
const form = reactive({ name: '', description: '', permissions: 0 })
const query = useQuery({ queryKey: computed(() => ['project-policies', props.serverId]), queryFn: () => api<{ policies: ProjectPolicy[] }>(`/api/servers/${props.serverId}/project-policies`) })
const visible = computed(() => (query.data.value?.policies ?? []).filter(p => `${p.name} ${p.description}`.toLowerCase().includes(search.value.toLowerCase())))
function edit(policy: ProjectPolicy | null) { editing.value = policy; Object.assign(form, { name: policy?.name ?? '', description: policy?.description ?? '', permissions: policy?.permissions ?? 0 }); open.value = true }
function toggle(flag: number, enabled: boolean) { form.permissions = enabled ? form.permissions | flag : form.permissions & ~flag }
async function save() {
  busy.value = true
  try {
    await api(editing.value ? `/api/project-policies/${editing.value.id}` : `/api/servers/${props.serverId}/project-policies`, { method: editing.value ? 'PATCH' : 'POST', body: { ...form, ...(editing.value ? { version: editing.value.version } : {}) } })
    open.value = false; await query.refetch(); await cache.invalidateQueries({ queryKey: ['project-access'] }); await cache.invalidateQueries({ queryKey: ['members', props.serverId] })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <div class="space-y-6">
    <SettingsHeader title="Project policies" description="Reusable permissions for people and agents. Assign a policy to a member or Server role inside a project." />
    <div class="flex flex-wrap items-center justify-between gap-3"><UInput v-model="search" placeholder="Search policies" aria-label="Search policies" icon="i-ph-magnifying-glass" /><UButton label="Create policy" icon="i-ph-plus" @click="edit(null)" /></div>
    <LayoutLoadError v-if="query.error.value" message="Project policies did not load." :retry="query.refetch" />
    <div class="divide-y divide-default rounded-lg border border-default">
      <button v-for="policy in visible" :key="policy.id" class="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-elevated" @click="edit(policy)"><span><span class="block font-medium">{{ policy.name }}</span><span class="mt-1 block text-sm text-muted">{{ policy.description }}</span></span><UIcon name="i-ph-caret-right" class="size-4 shrink-0" /></button>
    </div>
    <p v-if="!query.isPending.value && !visible.length" class="text-sm text-muted">No policies match your search.</p>
    <UModal v-model:open="open" :title="editing ? 'Edit policy' : 'Create policy'" description="Changes apply to every project assignment using this policy and revoke active runs using its previous version.">
      <template #body><form class="space-y-5" @submit.prevent="save">
        <UFormField label="Name"><UInput v-model="form.name" required maxlength="80" class="w-full" /></UFormField>
        <UFormField label="Description"><UTextarea v-model="form.description" maxlength="2000" class="w-full" /></UFormField>
        <fieldset class="space-y-3"><legend class="mb-3 font-medium">Permissions</legend><UCheckbox v-for="grant in ProjectPolicyGrants" :key="grant.key" :label="grant.label" :description="grant.description" :model-value="Boolean(form.permissions & grant.flag)" @update:model-value="toggle(grant.flag, Boolean($event))" /></fieldset>
        <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Save policy" :loading="busy" :disabled="!form.name.trim()" /></div>
      </form></template>
    </UModal>
  </div>
</template>
