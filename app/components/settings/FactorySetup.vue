<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const setup = useQuery({ queryKey: ['factory-setup'], queryFn: () => api<{ usage: { retained: number; active: number; recoveryRequired: number } | null; limits: { cpu?: number; memoryMiB?: number; diskBytes?: number; processLimit?: number; timeoutMs?: number } | null; placement: string; resources: boolean; state: string; nodeId: string | null; image: string | null; connectUrl: string | null; cli: string | null; durability: string; costs: string }>('/api/factory'), refetchOnWindowFocus: true })
const acknowledged = ref(false), busy = ref(false), failure = ref('')
async function configure(enabled: boolean) {
  if (busy.value) return
  busy.value = true
  failure.value = ''
  try { await api('/api/factory', { method: 'POST', body: { enabled, acknowledgeCosts: true } }); await setup.refetch(); await cache.invalidateQueries({ queryKey: ['compute-nodes'] }) }
  catch (error) { failure.value = errorMessage(error); toast.add({ title: failure.value, color: 'error' }) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-3 rounded-lg border border-default p-4">
    <h2 class="font-medium">Software Factory</h2>
    <LayoutLoadError v-if="setup.error.value" message="Factory setup did not load." :retry="setup.refetch" />
    <template v-if="setup.data.value">
      <p class="text-sm">{{ setup.data.value.state === 'unavailable' ? 'Coding execution is not connected' : setup.data.value.state === 'failed_recovery' ? 'Source recovery requires inspection; uncertain commands will not replay' : setup.data.value.state === 'paused' ? 'Factory paused; source retained' : setup.data.value.state === 'ready' ? 'Factory ready' : 'Factory disabled' }}</p>
      <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />
      <p class="text-sm text-muted">{{ setup.data.value.durability }}</p>
      <template v-if="setup.data.value.placement === 'cloudflare'">
        <p class="text-sm text-muted">Optional Cloudflare Containers and Artifacts require Workers Paid and available provider access. Basic L4 works without them. R2 remains independent.</p>
        <p class="text-xs text-muted">{{ setup.data.value.costs }} Choose compute size, command time and process limits during provisioning. Each Task has a 500 MB retained Git-object budget and one operation runs at a time. No nested Docker. Idle compute is stopped after each checkpoint.</p>
        <UButton v-if="!setup.data.value.resources && setup.data.value.connectUrl" :to="setup.data.value.connectUrl" external target="_blank" label="Enable Factory in Cloudflare" />
        <template v-if="setup.data.value.resources && ['disabled', 'paused'].includes(setup.data.value.state)">
          <UCheckbox v-model="acknowledged" label="I authorize Factory compute, code storage and network usage in my Cloudflare account." />
          <UButton label="Activate Factory" :disabled="!acknowledged" :loading="busy" @click="configure(true)" />
        </template>
        <UButton v-if="['ready', 'failed_recovery'].includes(setup.data.value.state)" label="Pause Factory and retain source" color="neutral" variant="outline" :loading="busy" @click="configure(false)" />
      </template>
      <template v-else>
        <p class="text-sm text-muted">Enable the local executor on this VPS. The verified release installs its service and workspace image and pairs it automatically after the Owner is claimed. Docker shares the host kernel; use trusted code and users. Reserve capacity for your Server.</p>
        <p class="text-xs text-muted">{{ setup.data.value.costs }}</p>
        <code class="block select-all overflow-auto rounded bg-elevated p-3 text-xs">{{ setup.data.value.cli }}</code>
        <p class="text-xs text-muted">Use llll factory status, logs, restart, disable or backup on the VPS. Disable preserves Task disks and receipts. Advanced remote Nodes remain available below.</p>
      </template>
      <p v-if="setup.data.value.usage" class="text-xs text-muted">{{ setup.data.value.usage.retained }} retained Task source stores · {{ setup.data.value.usage.active }} active operations · {{ setup.data.value.usage.recoveryRequired }} outcomes requiring inspection. Review each affected private Run before continuing.</p>
      <p v-if="setup.data.value.limits" class="text-xs text-muted">Configured policy: {{ setup.data.value.limits.cpu ?? 1 }} CPU · {{ setup.data.value.limits.memoryMiB ?? 1024 }} MiB RAM · {{ setup.data.value.limits.diskBytes }} disk bytes · {{ setup.data.value.limits.processLimit ?? 128 }} processes · {{ (setup.data.value.limits.timeoutMs ?? 120000) / 1000 }} seconds per command.</p>
      <p v-if="setup.data.value.image" class="break-all text-xs text-muted">Released image: {{ setup.data.value.image }}</p>
    </template>
  </section>
</template>
