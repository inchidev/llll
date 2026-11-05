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
function nodeStatus(node: ComputeNode) {
  if (!node.enabled) return 'Disabled'
  if (node.capabilities.provider === 'cloudflare-containers') return 'Managed provider ready'
  return node.lastSeen && Date.now() - Date.parse(node.lastSeen) < 30000 ? 'Connected' : 'Offline'
}
const items = computed(() => [
  { id: 'server-setup', name: 'Server compute setup', status: '', kind: 'server' as const },
  ...(nodes.data.value?.nodes ?? []).map(node => ({ id: node.id, name: node.name, status: nodeStatus(node), kind: 'node' as const })),
])
const addOpen = ref(false)
defineExpose({ openCreate: () => { addOpen.value = true } })
// Three ways to get compute, one Node protocol. L4 Compute is sold from llll.gg and is not available yet:
// no key, no environment variable and no price live on the Server.
const paths = [
  { id: 'vps', title: 'Your own VPS', text: 'The published Compute Node on a Linux Docker host you run. Free, with no limit on Nodes or parallel Runs.', action: 'Connect node' },
  { id: 'cloudflare', title: 'Your own Cloudflare', text: 'Containers in this Server\'s Cloudflare account. Free from L4; Cloudflare bills your account.', action: 'Server compute setup' },
  { id: 'l4', title: 'L4 Compute', text: 'Managed workers bought from llll.gg, paired to this Server automatically. A self-hosted Server can use it too.', action: 'See pricing' },
] as const
function choose(id: (typeof paths)[number]['id']) {
  addOpen.value = false
  if (id === 'vps') { pairing.value = null; pairOpen.value = true }
  else if (id === 'cloudflare') emit('open-server')
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
    <SettingsList :items="items" :item-key="item => item.id" :search-text="item => item.name" placeholder="Search compute nodes" :noun="['node', 'nodes']" @select="item => { if (item.kind === 'server') emit('open-server'); else { selectedId = item.id; detailOpen = true } }"><template #row="{ item }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-cpu" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block text-sm font-medium text-highlighted">{{ item.name }}</span><span v-if="item.status" class="block text-xs text-muted">{{ item.status }}</span></span></template></SettingsList>
    <SettingsEditor v-model:open="addOpen" back="Compute" title="Add compute" description="Where Agents run repository work. The workspace is free; only L4 Compute is sold."><template #body><div class="flex flex-col gap-3">
      <div v-for="path in paths" :key="path.id" class="rounded border border-default p-3" :data-compute-path="path.id">
        <div class="flex items-baseline justify-between gap-3"><p class="text-sm font-medium text-highlighted">{{ path.title }}</p><span v-if="path.id === 'l4'" class="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-xs text-muted">Coming</span></div>
        <p class="mt-1 text-sm text-muted">{{ path.text }}</p>
        <UButton v-if="path.id === 'l4'" :label="path.action" color="neutral" variant="outline" class="mt-3" to="https://llll.gg/pricing" external target="_blank" />
        <UButton v-else :label="path.action" color="neutral" variant="outline" class="mt-3" @click="choose(path.id)" />
      </div>
    </div></template></SettingsEditor>
    <SettingsEditor v-model:open="detailOpen" back="Compute" :title="selected?.name ?? 'Compute node'" description="Connection status, capacity and access."><template #body>
    <div v-if="selected" class="flex flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
      <div class="min-w-0"><p>{{ selected.name }} · {{ nodeStatus(selected) }}</p><p class="break-all text-xs text-muted">{{ selected.id }} · {{ selected.capabilities.isolation === 'container-vm' ? 'Cloudflare VM container · durable code checkpoints' : 'Persistent Docker workspace · Shared kernel' }}<br>Last seen: {{ selected.lastSeen ? new Date(selected.lastSeen).toLocaleString() : 'Never' }} · Disk: {{ Number(selected.capabilities.diskBytes || 0) / 1048576 }} MiB · Parallel operations: {{ selected.capabilities.maxParallel }}<br>Image: {{ selected.capabilities.image }}</p></div>
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
  </section>
</template>
