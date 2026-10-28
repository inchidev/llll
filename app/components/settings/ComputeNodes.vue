<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ComputeNode } from '~~/shared/software-factory'
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const emit = defineEmits<{ 'open-server': [] }>()
const nodes = useQuery({ queryKey: ['compute-nodes'], queryFn: () => api<{ nodes: ComputeNode[] }>('/api/compute-nodes'), refetchInterval: 10000 })
const pairOpen = ref(false), detailOpen = ref(false), selectedId = ref<string | null>(null)
const selected = computed(() => nodes.data.value?.nodes.find(node => node.id === selectedId.value))
const name = ref('My Docker Node'), pairing = ref<{ token: string; expiresAt: string } | null>(null), busy = ref(false)
type LizardStatus = { phase: string; nodeId: string | null; error: string | null; retainedStorage: boolean; paused: boolean; expiresAt: number | null }
const lizard = useQuery({ queryKey: ['lizard-compute-connection'], queryFn: () => api<{ connection: { projectName: string; checkedAt: string } | null; compute: LizardStatus | null }>('/api/compute-providers/lizard'), refetchInterval: 5000 })
const items = computed(() => [
  { id: 'server-setup', name: 'Server compute setup', status: '', kind: 'server' as const },
  ...(lizard.data.value?.connection ? [{ id: 'lizard-provider', name: `Lizard · ${lizard.data.value.connection.projectName}`, status: lizard.data.value.compute?.phase === 'ready' ? 'Ready' : lizard.data.value.compute?.phase === 'stopped' ? 'Stopped' : lizard.data.value.compute?.phase === 'failed' ? 'Needs attention' : lizard.data.value.compute ? 'Preparing' : 'Connection verified', kind: 'lizard' as const }] : []),
  ...(nodes.data.value?.nodes ?? []).filter(node => node.capabilities.provider !== 'lizard').map(node => ({ id: node.id, name: node.name, status: !node.enabled ? 'Disabled' : node.capabilities.provider === 'cloudflare-containers' ? 'Managed provider ready' : node.lastSeen && Date.now() - Date.parse(node.lastSeen) < 30000 ? 'Connected' : 'Offline', kind: 'node' as const })),
])
const lizardOpen = ref(false), lizardDetailOpen = ref(false), lizardKey = ref(''), lizardProject = ref(''), lizardProjects = ref<{ id: string; name: string }[]>([])
const addOpen = ref(false)
defineExpose({ openCreate: () => { addOpen.value = true } })
async function checkLizard() {
  busy.value = true
  try {
    const result = await api<{ projects: { id: string; name: string }[] }>('/api/compute-providers/lizard/check', { method: 'POST', body: { apiKey: lizardKey.value } })
    lizardProjects.value = result.projects
    lizardProject.value = result.projects[0]?.id ?? ''
    if (!result.projects.length) toast.add({ title: 'No Lizard projects available to this key', color: 'warning' })
  } catch (error) { lizardProjects.value = []; toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function saveLizard() {
  busy.value = true
  try {
    await api('/api/compute-providers/lizard', { method: 'POST', body: { apiKey: lizardKey.value, projectId: lizardProject.value } })
    lizardKey.value = ''; lizardProjects.value = []; lizardOpen.value = false
    await cache.invalidateQueries({ queryKey: ['lizard-compute-connection'] })
    toast.add({ title: 'Lizard connection saved', color: 'success' })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function disconnectLizard() {
  busy.value = true
  try { await api('/api/compute-providers/lizard', { method: 'DELETE' }); await cache.invalidateQueries({ queryKey: ['lizard-compute-connection'] }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function changeLizardCompute(action: 'start' | 'stop') {
  busy.value = true
  try { await api(`/api/compute-providers/lizard/${action}`, { method: 'POST' }); await cache.invalidateQueries({ queryKey: ['lizard-compute-connection'] }); await cache.invalidateQueries({ queryKey: ['compute-nodes'] }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function discardLizardStorage() {
  busy.value = true
  try { await api('/api/compute-providers/lizard/storage', { method: 'DELETE' }); await cache.invalidateQueries({ queryKey: ['lizard-compute-connection'] }); await cache.invalidateQueries({ queryKey: ['compute-nodes'] }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function pair() {
  busy.value = true
  try { pairing.value = await api('/api/compute-nodes', { method: 'POST', body: { name: name.value } }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function disable(id: string) {
  busy.value = true
  try { await api('/api/compute-nodes/' + id, { method: 'DELETE' }); await cache.invalidateQueries({ queryKey: ['compute-nodes'] }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-3">
    <LayoutLoadError v-if="nodes.error.value" message="Compute Nodes did not load." :retry="nodes.refetch" />
    <LayoutLoadError v-if="lizard.error.value" message="Lizard connection did not load." :retry="lizard.refetch" />
    <SettingsList :items="items" :item-key="item => item.id" :search-text="item => item.name" placeholder="Search compute nodes" :noun="['node', 'nodes']" @select="item => { if (item.kind === 'server') emit('open-server'); else if (item.kind === 'lizard') lizardDetailOpen = true; else { selectedId = item.id; detailOpen = true } }"><template #row="{ item }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-cpu" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block text-sm font-medium text-highlighted">{{ item.name }}</span><span v-if="item.status" class="block text-xs text-muted">{{ item.status }}</span></span></template></SettingsList>
    <SettingsEditor v-model:open="addOpen" back="Compute" title="Add compute"><template #body><div class="flex flex-col gap-3"><UButton label="Connect node" color="neutral" variant="outline" @click="addOpen=false;pairing=null;pairOpen=true" /><UButton label="Connect Lizard" color="neutral" variant="outline" @click="addOpen=false;lizardKey='';lizardProjects=[];lizardOpen=true" /></div></template></SettingsEditor>
    <SettingsEditor v-model:open="lizardDetailOpen" back="Compute" title="Lizard" description="Connection and compute availability."><template #body><div class="space-y-3"><p class="text-sm">Project: {{ lizard.data.value?.connection?.projectName }}</p><p class="text-sm text-muted">{{ lizard.data.value?.compute?.error || (lizard.data.value?.compute?.phase === 'ready' ? 'Ready to use in a repository environment.' : lizard.data.value?.compute?.phase === 'stopped' ? 'VM stopped. Start it to use compute.' : 'Preparing or stopping compute.') }}</p><p v-if="lizard.data.value?.compute?.retainedStorage" class="text-sm text-muted">Task data is retained on a Lizard disk and storage charges may continue.</p><div class="flex gap-2"><UButton v-if="lizard.data.value?.compute?.phase === 'stopped'" label="Start compute" :loading="busy" @click="changeLizardCompute('start')" /><UButton v-else-if="lizard.data.value?.compute" label="Stop VM" color="neutral" variant="outline" :loading="busy" @click="changeLizardCompute('stop')" /><UButton v-if="lizard.data.value?.compute?.phase === 'stopped' && lizard.data.value.compute.retainedStorage && !lizard.data.value.compute.paused" label="Pause automatic start" color="neutral" variant="outline" :loading="busy" @click="changeLizardCompute('stop')" /><UButton v-if="lizard.data.value?.compute?.phase === 'stopped' && lizard.data.value.compute.retainedStorage" label="Delete unused storage" color="neutral" variant="outline" :loading="busy" @click="discardLizardStorage" /><UButton v-if="!lizard.data.value?.compute || (lizard.data.value.compute.phase === 'stopped' && !lizard.data.value.compute.retainedStorage)" label="Disconnect" color="neutral" variant="ghost" :loading="busy" @click="disconnectLizard();lizardDetailOpen=false" /></div></div></template></SettingsEditor>
    <SettingsEditor v-model:open="detailOpen" back="Compute" :title="selected?.name ?? 'Compute node'" description="Connection status, capacity and access."><template #body>
    <div v-if="selected" class="flex flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
      <div class="min-w-0"><p>{{ selected.name }} · {{ !selected.enabled ? 'Disabled' : selected.capabilities.provider === 'cloudflare-containers' ? 'Managed provider ready' : selected.lastSeen && Date.now() - Date.parse(selected.lastSeen) < 30000 ? 'Connected' : 'Offline' }}</p><p class="break-all text-xs text-muted">{{ selected.id }} · {{ selected.capabilities.isolation === 'container-vm' ? 'Cloudflare VM container · durable code checkpoints' : 'Persistent Docker workspace · Shared kernel' }}<br>Last seen: {{ selected.lastSeen ? new Date(selected.lastSeen).toLocaleString() : 'Never' }} · Disk: {{ Number(selected.capabilities.diskBytes || 0) / 1048576 }} MiB · Parallel operations: {{ selected.capabilities.maxParallel }}<br>Image: {{ selected.capabilities.image }}</p></div>
      <UButton v-if="selected.enabled" label="Disable and revoke" color="neutral" variant="outline" :loading="busy" @click="disable(selected.id)" />
    </div>
    </template></SettingsEditor>
    <p v-if="nodes.data.value && !nodes.data.value.nodes.length" class="text-sm text-muted">No Compute Node is connected. Repository metadata remains available; coding needs a Node.</p>
    <SettingsEditor v-model:open="pairOpen" back="Compute" title="Connect compute node" description="Pair Docker on your VPS or local machine."><template #body><div class="space-y-4">
    <UFormField label="Node name"><UInput v-model="name" class="w-full" /></UFormField>
    <UButton label="Create pairing code" color="neutral" :loading="busy" :disabled="!name.trim()" @click="pair" />
    <div v-if="pairing" class="space-y-2">
      <p class="text-sm">Use this code once in your Node setup. It expires {{ new Date(pairing.expiresAt).toLocaleString() }}. Keep it private.</p>
      <code class="block break-all select-all rounded bg-elevated p-3 text-xs">{{ pairing.token }}</code>
      <p class="text-sm text-muted">Start a compute node with this Server address, the pairing code and a pinned workspace image. Select the connected node for your repository.</p>
    </div>
    </div></template></SettingsEditor>
    <SettingsEditor v-model:open="lizardOpen" back="Compute" title="Connect Lizard" description="Check your API key and select a Lizard project."><template #body><div class="space-y-4">
      <UFormField label="Lizard API key"><UInput v-model="lizardKey" type="password" autocomplete="off" class="w-full" @update:model-value="lizardProjects=[];lizardProject=''" /></UFormField>
      <UButton label="Check connection" color="neutral" :loading="busy" :disabled="!lizardKey.trim()" @click="checkLizard" />
      <UFormField v-if="lizardProjects.length" label="Project"><USelect v-model="lizardProject" :items="lizardProjects.map(project => ({ label: project.name, value: project.id }))" class="w-full" /></UFormField>
      <p v-if="lizardProjects.length" class="text-sm text-muted">Saving starts a temporary compute VM. Lizard compute and retained storage may incur charges.</p>
      <UButton v-if="lizardProjects.length" label="Save connection" :loading="busy" :disabled="!lizardProject" @click="saveLizard" />
    </div></template></SettingsEditor>
  </section>
</template>
