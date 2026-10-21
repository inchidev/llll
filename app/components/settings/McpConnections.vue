<script setup lang="ts">
import { MCP_SCOPE_LABELS, type McpConnectionDTO } from '~~/shared/mcp'

const { api, serverUrl } = useApi()
const connections = shallowRef<McpConnectionDTO[]>([])
const loading = ref(true)
const error = ref('')
const revoking = ref('')
const target = shallowRef<McpConnectionDTO | null>(null)

onMounted(async () => {
  try { connections.value = (await api<{ connections: McpConnectionDTO[] }>('/api/mcp/connections')).connections }
  catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
})

async function revoke() {
  if (!target.value) return
  const id = target.value.id
  revoking.value = id
  error.value = ''
  try {
    await api(`/api/mcp/connections/${id}`, { method: 'DELETE' })
    connections.value = connections.value.filter(connection => connection.id !== id)
    target.value = null
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { revoking.value = '' }
}
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Connected apps</h1>
    <p class="mt-2 text-sm text-muted">Applications connected as you, and connections for Agents you manage.</p>
    <UFormField label="MCP Server URL" class="mt-6">
      <UInput :model-value="serverUrl('/mcp')" readonly class="w-full font-mono" />
    </UFormField>
    <UAlert v-if="error" class="mt-6" color="error" variant="subtle" title="Connections could not be updated" :description="error" />
    <p v-if="loading" role="status" class="mt-6 text-sm text-muted">Loading connections…</p>
    <p v-else-if="!connections.length && !error" class="mt-6 text-sm text-muted">No connected apps. Add the MCP Server URL in your client to connect.</p>
    <ul v-else class="mt-6 divide-y divide-default">
      <li v-for="connection in connections" :key="connection.id" class="flex flex-wrap items-start gap-4 py-5">
        <div class="min-w-0 flex-1">
          <p class="break-words font-medium text-highlighted">{{ connection.clientName }}</p>
          <p class="mt-1 text-sm text-muted">Acts as {{ connection.subject.displayName }}{{ connection.subject.kind === 'agent' ? ' · Agent' : '' }}</p>
          <p class="mt-2 text-sm text-muted">{{ connection.scopes.map(scope => MCP_SCOPE_LABELS[scope]).join(', ') }}</p>
          <p class="mt-2 text-xs text-muted">{{ connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : 'Not used yet' }}</p>
        </div>
        <UButton label="Revoke" color="error" variant="soft" @click="target = connection" />
      </li>
    </ul>
    <UModal :open="Boolean(target)" title="Revoke app access?" @update:open="value => { if (!value) target = null }">
      <template #body>
        <p class="text-sm text-muted">{{ target?.clientName || 'This app' }} will lose this connection’s access immediately.</p>
      </template>
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="outline" :disabled="Boolean(revoking)" @click="target = null" />
        <UButton label="Revoke access" color="error" :loading="Boolean(revoking)" @click="revoke" />
      </template>
    </UModal>
  </div>
</template>
