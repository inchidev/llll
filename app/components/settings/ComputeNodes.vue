<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computeNodeUpdate, type ComputeNode } from '~~/shared/software-factory'
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const emit = defineEmits<{ 'open-server': [] }>()
const l4 = useL4Compute()
const nodes = useQuery({ queryKey: ['compute-nodes'], queryFn: () => api<{ nodes: ComputeNode[] }>('/api/compute-nodes'), refetchInterval: 10000 })
const pairOpen = ref(false), detailOpen = ref(false), selectedId = ref<string | null>(null)
const selected = computed(() => nodes.data.value?.nodes.find(node => node.id === selectedId.value))
const name = ref('My Docker Node'), pairing = ref<{ token: string; expiresAt: string } | null>(null), busy = ref(false)
function nodeStatus(node: ComputeNode) {
  if (!node.enabled) return 'Disabled'
  if (computeNodeUpdate(node)) return 'Needs this release’s Compute Node'
  if (node.capabilities.provider === 'cloudflare-containers') return 'Managed provider ready'
  if (node.capabilities.provider === 'l4-compute') return 'Linked to llll.gg · a box per Task'
  return node.lastSeen && Date.now() - Date.parse(node.lastSeen) < 30000 ? 'Connected' : 'Offline'
}
const items = computed(() => [
  { id: 'server-setup', name: 'Server compute setup', status: '', kind: 'server' as const },
  ...(nodes.data.value?.nodes ?? []).map(node => ({ id: node.id, name: node.name, status: nodeStatus(node), kind: 'node' as const })),
])
const addOpen = ref(false)
defineExpose({ openCreate: () => { addOpen.value = true } })
// Three ways to get compute, one Node protocol (ADR 0009). L4 Compute is a box per Task, started and stopped by llll.gg
// and paid by the hour of agent work, billed by the minute; the Owner links it by signing in on llll.gg, and no key, environment variable or price lives on the Server.
const paths = [
  { id: 'vps', title: 'Your own VPS', text: 'The published Compute Node on a Linux Docker host you run. Free, with no limit on Nodes or parallel Runs.', action: 'Connect node' },
  { id: 'cloudflare', title: 'Your own Cloudflare', text: 'Containers in this Server\'s Cloudflare account. Free from L4; Cloudflare bills your account.', action: 'Server compute setup' },
  { id: 'l4', title: 'L4 Compute', text: 'A box for each Task, started and stopped by llll.gg and paid by the hour of agent work and billed by the minute, with no limit on how many Agents work at once. A self-hosted Server can use it too.', action: 'Add L4 Compute' },
] as const
const l4State = computed(() => l4.overview.data.value?.hosted ? 'This Server runs on L4 Cloud and already has it.' : l4.overview.data.value?.linked ? `Linked to llll.gg account ${l4.overview.data.value.account}.` : l4.overview.data.value && !l4.overview.data.value.canConnect ? 'Configure this Server’s public origin first.' : null)
function choose(id: (typeof paths)[number]['id']) {
  addOpen.value = false
  if (id === 'vps') { pairing.value = null; pairOpen.value = true }
  else if (id === 'cloudflare') emit('open-server')
  else void l4.connect()
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
        <p class="text-sm font-medium text-highlighted">{{ path.title }}</p>
        <p class="mt-1 text-sm text-muted">{{ path.text }}</p>
        <p v-if="path.id === 'l4' && l4State" class="mt-1 text-xs text-muted">{{ l4State }}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <UButton :label="path.action" color="neutral" variant="outline" :disabled="path.id === 'l4' && (!l4.overview.data.value || l4.overview.data.value.linked || !l4.overview.data.value.canConnect)" :loading="path.id === 'l4' && l4.busy.value" @click="choose(path.id)" />
          <UButton v-if="path.id === 'l4'" label="See pricing" color="neutral" variant="link" to="https://llll.gg/pricing" external target="_blank" />
        </div>
      </div>
    </div></template></SettingsEditor>
    <SettingsEditor v-model:open="detailOpen" back="Compute" :title="selected?.name ?? 'Compute node'" description="Connection status, capacity and access."><template #body>
    <UAlert v-if="selected && computeNodeUpdate(selected)" color="warning" variant="subtle" icon="i-ph-warning" title="Earlier Compute Node" :description="computeNodeUpdate(selected)!.text" class="mb-3" data-compute-update />
    <div v-if="selected" class="flex flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
      <div class="min-w-0"><p>{{ selected.name }} · {{ nodeStatus(selected) }}</p><p v-if="selected.capabilities.provider === 'l4-compute'" class="break-all text-xs text-muted">{{ selected.id }} · A microVM per Task from llll.gg, its disk kept until the Task is Done · Paid by the hour of agent work. Each box pairs as a Node of its own under this one.</p>
      <p v-else class="break-all text-xs text-muted">{{ selected.id }} · {{ selected.capabilities.isolation === 'container-vm' ? 'Cloudflare VM container · durable code checkpoints' : selected.placementId ? 'An L4 Compute box: one microVM for this Task, its disk kept' : 'One Docker box per Task, its disk kept · Shared kernel' }}<br>Last seen: {{ selected.lastSeen ? new Date(selected.lastSeen).toLocaleString() : 'Never' }} · Disk: {{ Number(selected.capabilities.diskBytes || 0) / 1048576 }} MiB · Boxes at once: {{ (selected.capabilities.capacity as { boxes?: number } | undefined)?.boxes ?? 1 }}<br>Image: {{ selected.capabilities.image }}</p></div>
      <UButton v-if="selected.enabled" :label="selected.placementId ? 'Release this box' : selected.capabilities.provider === 'l4-compute' ? 'Pause' : 'Disable and revoke'" color="neutral" variant="outline" :loading="busy" @click="disable(selected.id)" />
    </div>
    </template></SettingsEditor>
    <p v-if="nodes.data.value && !nodes.data.value.nodes.length" class="text-sm text-muted">No Compute Node is connected. Repository metadata remains available; coding needs a Node.</p>
    <SettingsEditor v-model:open="pairOpen" back="Compute" title="Connect compute node" description="Pair Docker on your VPS or local machine."><template #body><div class="space-y-4">
    <UFormField label="Node name"><UInput v-model="name" class="w-full" /></UFormField>
    <UButton label="Create pairing code" color="neutral" :loading="busy" :disabled="!name.trim()" @click="pair" />
    <div v-if="pairing" class="space-y-2">
      <p class="text-sm">Use this code once in your Node setup. It expires {{ new Date(pairing.expiresAt).toLocaleString() }}. Keep it private.</p>
      <code class="block break-all select-all rounded bg-elevated p-3 text-xs">{{ pairing.token }}</code>
      <p class="text-sm text-muted">Start a compute node with this Server address, the pairing code and a pinned box image. Select the connected node for your repository.</p>
    </div>
    </div></template></SettingsEditor>
  </section>
</template>
