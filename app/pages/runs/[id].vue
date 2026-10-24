<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { RunDelivery } from '~~/server/utils/agent-run-delivery'
import { Permission } from '~~/shared/permissions'
import type { AgentRun } from '~~/shared/agent-execution'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const route = useRoute()
const { api } = useApi()
const { can } = useRoleGrants()
const toast = useToast()
const downloading = ref(false)
const transcriptDownloading = ref(false)
async function downloadTranscript() {
  transcriptDownloading.value = true
  try {
    const blob = await api<Blob>(`/api/agent-runs/${route.params.id}/transcript`, { responseType: 'blob' })
    const url = URL.createObjectURL(blob), anchor = document.createElement('a')
    anchor.href = url; anchor.download = `run-${route.params.id}.jsonl`; document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { transcriptDownloading.value = false }
}
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
  queryFn: () => api<{ delivery: RunDelivery | null; run: Omit<AgentRun, 'instructions' | 'mandateJson' | 'environmentJson' | 'filesKey'> & { hasFiles: boolean }; canCancel: boolean; canRetry: boolean; modelCalls: { callNumber: number; model: string; status: string; startedAt: string; completedAt: string | null; totalTokens: number | null; error: string | null }[]; events: { sequence: number; event: { type: string; text?: string; message?: string; name?: string }; createdAt: string }[] }>(`/api/agent-runs/${route.params.id}`),
  refetchInterval: query => ['queued', 'running'].includes(query.state.data?.run.status ?? '') || query.state.data?.delivery?.reportStatus === 'pending' || query.state.data?.delivery?.taskStatus === 'pending' ? 2000 : false,
})
const run = computed(() => runQ.data.value?.run)
async function cancel() {
  cancelling.value = true
  try { await api(`/api/agent-runs/${route.params.id}/cancel`, { method: 'POST' }); await runQ.refetch() }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
    await runQ.refetch()
  }
  finally { cancelling.value = false }
}
const delivering = ref(false)
async function retryDelivery() {
  if (delivering.value) return
  delivering.value = true
  try { await api(`/api/agent-runs/${route.params.id}/deliver`, { method: 'POST' }); await runQ.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { delivering.value = false }
}
const retrying = ref(false)
async function retryRun() {
  retrying.value = true
  try {
    const result = await api<{ run: { id: string } }>(`/api/agent-runs/${route.params.id}/retry`, { method: 'POST', body: { requestId: crypto.randomUUID() } })
    await navigateTo(`/runs/${result.run.id}`)
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { retrying.value = false }
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
      <p v-if="run.status === 'queued'" class="text-sm text-muted">Waiting for a free execution slot. The execution time limit starts when this Run begins.</p>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <dt class="text-muted">Started</dt><dd>{{ new Date(run.createdAt).toLocaleString() }}</dd>
        <dt class="text-muted">Model</dt><dd class="break-all">{{ run.model }}</dd>
        <dt class="text-muted">Model calls</dt><dd>{{ run.modelCalls }}</dd>
        <dt class="text-muted">Tokens used or reserved</dt><dd>{{ run.totalTokens }}</dd>
      </dl>
      <UAlert v-if="run.lastError" color="error" :description="run.lastError" title="Run stopped" />
      <section v-if="runQ.data.value?.delivery" class="space-y-2">
        <h2 class="text-sm font-medium">Result delivery</h2>
        <p v-if="run.taskId" class="text-sm">Task result: {{ runQ.data.value.delivery.taskStatus }}</p>
        <p class="text-sm">Conversation report: {{ runQ.data.value.delivery.reportStatus }}</p>
        <p v-if="runQ.data.value.delivery.taskError" class="text-sm text-warning">{{ runQ.data.value.delivery.taskError }}</p>
        <p v-if="runQ.data.value.delivery.reportError" class="text-sm text-warning">{{ runQ.data.value.delivery.reportError }}</p>
        <UButton v-if="runQ.data.value.canRetry && (runQ.data.value.delivery.taskStatus === 'blocked' || runQ.data.value.delivery.reportStatus === 'blocked')" label="Retry delivery" :loading="delivering" color="neutral" variant="outline" @click="retryDelivery" />
        <p v-if="runQ.data.value.delivery.reportStatus !== 'complete'" class="text-xs text-muted">Delivery uses the saved result and does not run the model again.</p>
      </section>
      <section class="space-y-2"><h2 class="text-sm font-medium">Instruction</h2><p class="whitespace-pre-wrap text-sm text-muted">{{ run.prompt }}</p></section>
      <section v-if="runQ.data.value?.modelCalls?.length" class="space-y-2"><h2 class="text-sm font-medium">Model requests</h2><ol class="space-y-2"><li v-for="call in runQ.data.value.modelCalls" :key="call.callNumber" class="rounded border border-default p-3 text-sm"><p class="break-all">#{{ call.callNumber }} · {{ call.model }} · {{ call.status }}</p><p class="text-xs text-muted">{{ new Date(call.startedAt).toLocaleString() }} · {{ call.totalTokens ?? 'reserved' }} tokens</p><p v-if="call.error" class="text-error">{{ call.error }}</p></li></ol></section>
      <UButton v-if="['completed', 'failed', 'cancelled'].includes(run.status)" label="Download transcript" color="neutral" variant="outline" :loading="transcriptDownloading" @click="downloadTranscript" />
      <section v-if="run.resultText" class="space-y-2"><h2 class="text-sm font-medium">Result</h2><div class="whitespace-pre-wrap text-sm text-default">{{ run.resultText }}</div></section>
      <section v-if="runQ.data.value?.events?.length" class="space-y-2">
        <h2 class="text-sm font-medium">Activity</h2>
        <ol class="space-y-2"><li v-for="entry in runQ.data.value.events" :key="entry.sequence" class="rounded border border-default p-3 text-sm">
          <span class="text-xs text-muted">{{ new Date(entry.createdAt).toLocaleString() }} · {{ entry.event.type }}</span>
          <p class="whitespace-pre-wrap break-words">{{ entry.event.message || entry.event.text || entry.event.name }}</p>
        </li></ol>
      </section>
      <UButton v-if="runQ.data.value?.canRetry && ['failed', 'cancelled'].includes(run.status)" label="Retry run" icon="i-ph-arrow-clockwise" :loading="retrying" @click="retryRun" />
      <UButton v-if="run.hasFiles && can(Permission.useComputer)" label="Download working files" icon="i-ph-download" color="neutral" variant="outline" :loading="downloading" @click="downloadFiles" />
      <UButton v-if="runQ.data.value?.canCancel && ['queued', 'running'].includes(run.status)" label="Stop run" color="neutral" variant="outline" :loading="cancelling" @click="cancel" />
    </template>
    </main>
  </div>
</template>
