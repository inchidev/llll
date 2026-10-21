<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import type { AgentRun } from '~~/shared/agent-execution'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const route = useRoute()
const { api } = useApi()
const { can } = useRoleGrants()
const toast = useToast()
const downloading = ref(false)
const cancelling = ref(false)
async function downloadFiles() {
  downloading.value = true
  try {
    const files = await api<unknown>(`/api/agent-runs/${route.params.id}/files`)
    const url = URL.createObjectURL(new Blob([JSON.stringify(files)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `run-${route.params.id}-files.json`
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { downloading.value = false }
}
const runQ = useQuery({
  queryKey: computed(() => ['agent-run', route.params.id]),
  queryFn: () => api<{ run: Omit<AgentRun, 'instructions' | 'mandateJson' | 'environmentJson' | 'filesKey'> & { hasFiles: boolean }; canCancel: boolean }>(`/api/agent-runs/${route.params.id}`),
  refetchInterval: query => ['queued', 'running'].includes(query.state.data?.run.status ?? '') ? 2000 : false,
})
const run = computed(() => runQ.data.value?.run)
async function cancel() {
  cancelling.value = true
  try { await api(`/api/agent-runs/${route.params.id}/cancel`, { method: 'POST' }); await runQ.refetch() }
  finally { cancelling.value = false }
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Agent run" icon="i-ph-robot" />
    <main class="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-auto p-4 sm:p-8">
    <LayoutSkeleton v-if="runQ.isPending.value" variant="form" />
    <LayoutLoadError v-else-if="runQ.error.value" message="This run did not load." :retry="runQ.refetch" />
    <template v-else-if="run">
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-lg font-medium text-highlighted">Execution</h2>
        <UBadge :label="run.status" color="neutral" variant="subtle" />
      </div>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <dt class="text-muted">Started</dt><dd>{{ new Date(run.createdAt).toLocaleString() }}</dd>
        <dt class="text-muted">Model calls</dt><dd>{{ run.modelCalls }}</dd>
        <dt class="text-muted">Tokens used or reserved</dt><dd>{{ run.totalTokens }}</dd>
      </dl>
      <UAlert v-if="run.lastError" color="error" :description="run.lastError" title="Run stopped" />
      <section class="space-y-2"><h2 class="text-sm font-medium">Instruction</h2><p class="whitespace-pre-wrap text-sm text-muted">{{ run.prompt }}</p></section>
      <section v-if="run.resultText" class="space-y-2"><h2 class="text-sm font-medium">Result</h2><div class="whitespace-pre-wrap text-sm text-default">{{ run.resultText }}</div></section>
      <UButton v-if="run.hasFiles && can(Permission.useComputer)" label="Download working files" icon="i-ph-download" color="neutral" variant="outline" :loading="downloading" @click="downloadFiles" />
      <UButton v-if="runQ.data.value?.canCancel && ['queued', 'running'].includes(run.status)" label="Stop run" color="neutral" variant="outline" :loading="cancelling" @click="cancel" />
    </template>
    </main>
  </div>
</template>
