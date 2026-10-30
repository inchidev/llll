<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { Project } from '~~/shared/projects'
const props = defineProps<{ serverId: string }>()
const open = defineModel<boolean>('open', { default: false })
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const busy = ref(false), name = ref(''), description = ref('')
async function create() {
  busy.value = true
  try {
    const result = await api<{ project: Project }>(`/api/servers/${props.serverId}/projects`, { method: 'POST', body: { name: name.value, description: description.value } })
    name.value = ''; description.value = ''; open.value = false
    await cache.invalidateQueries({ queryKey: ['projects', props.serverId] })
    await navigateTo(`/factory/projects/${result.project.id}`)
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <UModal v-model:open="open" title="Create project" description="A project gathers tasks, repositories and access for people and agents.">
    <template #body><form class="space-y-4" @submit.prevent="create">
      <UFormField label="Project name"><UInput v-model="name" class="w-full" :maxlength="100" /></UFormField>
      <UFormField label="Description"><UTextarea v-model="description" class="w-full" /></UFormField>
      <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Create project" :disabled="!name.trim()" :loading="busy" /></div>
    </form></template>
  </UModal>
</template>
