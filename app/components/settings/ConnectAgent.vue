<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import { Permission } from '~~/shared/permissions'

const { serverUrl } = useApi()
const { can } = useRoleGrants()
const { copy } = useClipboard()
const toast = useToast()
const url = computed(() => serverUrl('/mcp'))
const clients = computed(() => [
  { name: 'Claude Code', command: `claude mcp add --scope user --transport http l4 ${url.value} && claude mcp login l4` },
  { name: 'Codex', command: `codex mcp add l4 --url ${url.value}` },
])
async function copyValue(value: string, label: string) {
  await copy(value)
  toast.add({ title: `${label} copied`, color: 'success' })
}
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Your agent</h1>
    <p class="mt-2 text-sm text-muted">Hand Tasks to the coding agent on your own computer, for free. It sees what you can see in this Server, nothing more, and you can revoke it in Connections.</p>
    <UAlert v-if="!can(Permission.mcpConnect)" class="mt-6" color="warning" variant="subtle" title="Your Role can’t connect agents yet" description="Ask the Server Owner to turn on Connect MCP clients for your Role." />

    <ol class="mt-6 space-y-6">
      <li>
        <h2 class="font-medium text-highlighted">1. Connect it once</h2>
        <p class="mt-1 text-sm text-muted">Run one command, sign in to this Server in the browser, and press Allow.</p>
        <div v-for="client in clients" :key="client.name" class="mt-3">
          <p class="text-xs font-medium text-muted">{{ client.name }}</p>
          <div class="mt-1 flex items-start gap-2">
            <code class="min-w-0 flex-1 break-all rounded bg-elevated p-2 font-mono text-xs">{{ client.command }}</code>
            <UButton icon="i-ph-copy" color="neutral" variant="outline" :aria-label="`Copy the ${client.name} command`" @click="copyValue(client.command, 'Command')" />
          </div>
        </div>
        <p class="mt-3 text-sm text-muted">Another MCP client, such as claude.ai, ChatGPT or Cursor: add this address as a custom connector.</p>
        <div class="mt-1 flex items-center gap-2">
          <UInput :model-value="url" readonly class="min-w-0 flex-1 font-mono" aria-label="MCP Server URL" />
          <UButton icon="i-ph-copy" color="neutral" variant="outline" aria-label="Copy the MCP Server URL" @click="copyValue(url, 'Address')" />
        </div>
      </li>
      <li>
        <h2 class="font-medium text-highlighted">2. Ask it about a Task</h2>
        <p class="mt-1 text-sm text-muted">In your repository, write “shots” for the newest recorded Task, “shots 4” for the last four, or “shots #12” for one. For a recorded Task, the agent gets the frames with your box and words on them, then moves the Task along as it works.</p>
      </li>
    </ol>
    <div class="mt-6 flex flex-wrap gap-2"><UButton to="/projects/board" label="Go to Tasks" icon="i-ph-kanban" color="neutral" variant="outline" /></div>
  </div>
</template>
