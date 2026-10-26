<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ComputeNode } from '~~/shared/software-factory'
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const nodes = useQuery({ queryKey: ['compute-nodes'], queryFn: () => api<{ nodes: ComputeNode[] }>('/api/compute-nodes'), refetchInterval: 10000 })
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
    <div v-for="node in nodes.data.value?.nodes" :key="node.id" class="flex flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
      <div class="min-w-0"><p>{{ node.name }} · {{ !node.enabled ? 'Disabled' : node.lastSeen && Date.now() - Date.parse(node.lastSeen) < 30000 ? 'Connected' : 'Offline' }}</p><p class="break-all text-xs text-muted">{{ node.id }} · Persistent Docker workspace · Shared kernel<br>Last seen: {{ node.lastSeen ? new Date(node.lastSeen).toLocaleString() : 'Never' }} · Disk: {{ Number(node.capabilities.diskBytes || 0) / 1048576 }} MiB · Parallel operations: {{ node.capabilities.maxParallel }}<br>Image: {{ node.capabilities.image }}</p></div>
      <UButton v-if="node.enabled" label="Disable and revoke" color="neutral" variant="outline" :loading="busy" @click="disable(node.id)" />
    </div>
    <p v-if="nodes.data.value && !nodes.data.value.nodes.length" class="text-sm text-muted">No Compute Node is connected. Repository metadata remains available; coding needs a Node.</p>
    <UFormField label="Node name"><UInput v-model="name" class="w-full" /></UFormField>
    <UButton label="Create pairing code" color="neutral" :loading="busy" :disabled="!name.trim()" @click="pair" />
    <div v-if="pairing" class="space-y-2">
      <p class="text-sm">Use this code once in your Node setup. It expires {{ new Date(pairing.expiresAt).toLocaleString() }}. Keep it private.</p>
      <code class="block break-all select-all rounded bg-elevated p-3 text-xs">{{ pairing.token }}</code>
      <p class="text-sm text-muted">Follow the Software Factory operator guide to start the Node with this Server address, the pairing code and a pinned workspace image. Select the connected Node in the repository environment.</p>
    </div>
  </section>
</template>
