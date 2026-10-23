<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { formatBytes } from '~~/shared/format'
const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const toast = useToast()
const busy = ref(false)
const storage = useQuery({ queryKey: computed(() => ['storage', props.serverId]), queryFn: () => api<{ backend: string; r2Available: boolean; migrating: boolean; usedBytes: number; limitBytes: number; maxFileBytes: number; files: number; copied: number; connectUrl: string | null }>(`/api/servers/${props.serverId}/storage`), refetchOnWindowFocus: true })
async function migrate() {
  busy.value = true
  try {
    let done = false
    while (!done) {
      const result = await api<{ done: boolean }>(`/api/servers/${props.serverId}/storage/migrate`, { method: 'POST', retry: 0 })
      done = result.done
      await storage.refetch()
      if (!done) await new Promise(resolve => setTimeout(resolve, 1500))
    }
    toast.add({ title: 'Files moved to R2', color: 'success' })
  } catch (error) { toast.add({ title: 'Migration paused; source files are preserved', description: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-4">
    <h2 class="text-xl font-semibold">Storage</h2>
    <LayoutLoadError v-if="storage.error.value" message="Storage settings did not load." :retry="storage.refetch" />
    <template v-else-if="storage.data.value">
      <p>{{ storage.data.value.backend === 'kv' ? 'Basic storage' : 'R2 storage' }}</p>
      <template v-if="storage.data.value.backend === 'kv'">
        <p class="text-sm text-muted">{{ formatBytes(storage.data.value.usedBytes) }} of {{ formatBytes(storage.data.value.limitBytes) }} used · up to 20 MiB per file. Basic storage shares Cloudflare’s daily KV quota with this Server’s connection tickets.</p>
        <UButton v-if="!storage.data.value.r2Available && storage.data.value.connectUrl" :to="storage.data.value.connectUrl" external target="_blank" label="Connect R2" />
        <template v-if="storage.data.value.r2Available">
          <p class="text-sm text-muted">Move files to R2. Uploads pause during the copy; existing files stay readable. Original KV files are retained.</p>
          <p v-if="storage.data.value.migrating" class="text-sm text-muted">Verified {{ storage.data.value.copied }} of {{ storage.data.value.files }} files.</p>
          <UButton :label="storage.data.value.migrating ? 'Resume migration to R2' : 'Move files to R2'" :loading="busy" @click="migrate" />
        </template>
      </template>
    </template>
  </section>
</template>
