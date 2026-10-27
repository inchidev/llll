<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ComputeNode } from '~~/shared/software-factory'
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const nodes = useQuery({ queryKey: ['compute-nodes'], queryFn: () => api<{ nodes: ComputeNode[] }>('/api/compute-nodes'), refetchInterval: 10000 })
const pairOpen = ref(false), detailOpen = ref(false), selectedId = ref<string | null>(null), search = ref('')
const selected = computed(() => nodes.data.value?.nodes.find(node => node.id === selectedId.value))
const visible = computed(() => (nodes.data.value?.nodes ?? []).filter(node => node.name.toLowerCase().includes(search.value.toLowerCase())))
const name = ref('My Docker Node'), pairing = ref<{ token: string; expiresAt: string } | null>(null), busy = ref(false)
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
  <section class="space-y-3 rounded-lg border border-default p-4">
    <h3 class="font-medium">Compute Nodes</h3>
    <p class="text-sm text-muted">Connect Docker on your VPS or local machine. The Node connects outward to this Server and retains each Task's workspace disk. Docker shares the host kernel; use this provider only for code and users you trust.</p>
    <LayoutLoadError v-if="nodes.error.value" message="Compute Nodes did not load." :retry="nodes.refetch" />
    <div class="flex flex-wrap gap-3"><UInput v-model="search" aria-label="Search compute nodes" placeholder="Search nodes" /><UButton label="Connect node" icon="i-ph-plus" @click="pairing=null;pairOpen=true" /></div>
    <div class="divide-y divide-default rounded-lg border border-default"><button v-for="node in visible" :key="node.id" class="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-elevated" @click="selectedId=node.id;detailOpen=true"><span class="font-medium">{{node.name}}</span><span class="text-sm text-muted">{{!node.enabled ? 'Disabled' : node.capabilities.provider === 'cloudflare-containers' ? 'Managed provider ready' : node.lastSeen && Date.now()-Date.parse(node.lastSeen)<30000 ? 'Connected' : 'Offline'}}</span></button></div>
    <UModal v-model:open="detailOpen" :title="selected?.name ?? 'Compute node'" description="Connection status, capacity and access."><template #body>
    <div v-if="selected" class="flex flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
      <div class="min-w-0"><p>{{ selected.name }} · {{ !selected.enabled ? 'Disabled' : selected.capabilities.provider === 'cloudflare-containers' ? 'Managed provider ready' : selected.lastSeen && Date.now() - Date.parse(selected.lastSeen) < 30000 ? 'Connected' : 'Offline' }}</p><p class="break-all text-xs text-muted">{{ selected.id }} · {{ selected.capabilities.isolation === 'container-vm' ? 'Cloudflare VM container · durable code checkpoints' : 'Persistent Docker workspace · Shared kernel' }}<br>Last seen: {{ selected.lastSeen ? new Date(selected.lastSeen).toLocaleString() : 'Never' }} · Disk: {{ Number(selected.capabilities.diskBytes || 0) / 1048576 }} MiB · Parallel operations: {{ selected.capabilities.maxParallel }}<br>Image: {{ selected.capabilities.image }}</p></div>
      <UButton v-if="selected.enabled" label="Disable and revoke" color="neutral" variant="outline" :loading="busy" @click="disable(selected.id)" />
    </div>
    </template></UModal>
    <p v-if="nodes.data.value && !nodes.data.value.nodes.length" class="text-sm text-muted">No Compute Node is connected. Repository metadata remains available; coding needs a Node.</p>
    <UModal v-model:open="pairOpen" title="Connect compute node" description="Pair Docker on your VPS or local machine."><template #body><div class="space-y-4">
    <UFormField label="Node name"><UInput v-model="name" class="w-full" /></UFormField>
    <UButton label="Create pairing code" color="neutral" :loading="busy" :disabled="!name.trim()" @click="pair" />
    <div v-if="pairing" class="space-y-2">
      <p class="text-sm">Use this code once in your Node setup. It expires {{ new Date(pairing.expiresAt).toLocaleString() }}. Keep it private.</p>
      <code class="block break-all select-all rounded bg-elevated p-3 text-xs">{{ pairing.token }}</code>
      <p class="text-sm text-muted">Start a compute node with this Server address, the pairing code and a pinned workspace image. Select the connected node for your repository.</p>
    </div>
    </div></template></UModal>
  </section>
</template>
