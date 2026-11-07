<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { NetworkPreset, ProjectNetwork } from '~~/shared/project-factory'
type Presets = Record<NetworkPreset, { label: string; description: string; hosts: string[] }>
const props = defineProps<{ projectId: string; archived: boolean }>()
const { api } = useApi(), toast = useToast()
const query = useQuery({ queryKey: computed(() => ['project-network', props.projectId]), queryFn: () => api<{ network: ProjectNetwork; presets: Presets; canManage: boolean }>(`/api/projects/${props.projectId}/network`) })
const presets = ref<NetworkPreset[]>([]), hosts = ref<string[]>([]), host = ref(''), busy = ref(false)
watch(() => query.data.value?.network, network => { presets.value = [...network?.presets ?? []]; hosts.value = [...network?.hosts ?? []] }, { immediate: true })
const editable = computed(() => Boolean(query.data.value?.canManage) && !props.archived)
const changed = computed(() => JSON.stringify([[...presets.value].sort(), hosts.value]) !== JSON.stringify([[...query.data.value?.network.presets ?? []].sort(), query.data.value?.network.hosts ?? []]))
function toggle(preset: NetworkPreset, on: boolean) { presets.value = on ? [...new Set([...presets.value, preset])] : presets.value.filter(value => value !== preset) }
function addHost() {
  const value = host.value.trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '')
  if (value && !hosts.value.includes(value)) hosts.value = [...hosts.value, value]
  host.value = ''
}
async function save() {
  busy.value = true
  try { await api(`/api/projects/${props.projectId}/network`, { method: 'PUT', body: { presets: presets.value, hosts: hosts.value } }); await query.refetch(); toast.add({ title: 'Network saved', color: 'success' }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-4" aria-labelledby="project-network">
    <div><h3 id="project-network" class="font-medium">Network</h3><p class="mt-1 text-sm text-muted">An Agent’s box reaches only this Server until you open more. What you open here is open for every Task of this project; for anything else the Agent asks for a window, which a person opens for a stated time.</p></div>
    <LayoutLoadError v-if="query.error.value" message="The network did not load." :retry="query.refetch" />
    <template v-else-if="query.data.value">
      <div class="divide-y divide-default rounded-lg border border-default">
        <div v-for="(preset, id) in query.data.value.presets" :key="id" class="flex items-start justify-between gap-3 p-4">
          <div class="min-w-0"><p class="font-medium">{{ preset.label }}</p><p class="text-sm text-muted">{{ preset.description }}</p><p class="break-all text-xs text-muted">{{ preset.hosts.join(', ') }}</p></div>
          <USwitch :model-value="presets.includes(id)" :disabled="!editable" :aria-label="`Open ${preset.label}`" @update:model-value="value => toggle(id, Boolean(value))" />
        </div>
      </div>
      <div class="space-y-2">
        <p class="text-sm font-medium">Project hosts</p>
        <p class="text-sm text-muted">Services this project’s code talks to, such as api.example.com. Public host names only: no addresses, ports or wildcards.</p>
        <ul v-if="hosts.length" class="divide-y divide-default rounded-lg border border-default">
          <li v-for="entry in hosts" :key="entry" class="flex items-center justify-between gap-3 px-4 py-2"><span class="break-all font-mono text-sm">{{ entry }}</span><UButton v-if="editable" label="Remove" color="neutral" variant="ghost" size="sm" @click="hosts = hosts.filter(value => value !== entry)" /></li>
        </ul>
        <p v-else class="text-sm text-muted">No project hosts.</p>
        <form v-if="editable" class="flex flex-wrap gap-2" @submit.prevent="addHost"><UInput v-model="host" aria-label="Host to open" placeholder="api.example.com" class="min-w-0 flex-1" /><UButton type="submit" label="Add host" color="neutral" variant="outline" :disabled="!host.trim()" /></form>
      </div>
      <UButton v-if="editable" label="Save network" :disabled="!changed" :loading="busy" @click="save" />
    </template>
  </section>
</template>
