<script setup lang="ts">
import type { RunPublication } from '~~/shared/run-publication'
import type { ToolSecurityStatus } from '~~/server/utils/agent-tool-security'
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
  queryFn: () => api<{ factoryCalls: { callId: string; status: string; argumentsJson: string; error: string | null; createdAt: string }[]; publicationHistory: { id: string; status: string; decidedAt: string | null; decidedBy: string | null }[]; publication: RunPublication | null; security: ToolSecurityStatus; delivery: RunDelivery | null; run: Omit<AgentRun, 'instructions' | 'mandateJson' | 'environmentJson' | 'filesKey'> & { hasFiles: boolean; hasFactory: boolean }; canCancel: boolean; canRetry: boolean; modelCalls: { callNumber: number; model: string; status: string; startedAt: string; completedAt: string | null; totalTokens: number | null; error: string | null }[]; events: { sequence: number; event: { type: string; text?: string; message?: string; name?: string; purpose?: string }; createdAt: string }[] }>(`/api/agent-runs/${route.params.id}`),
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
const reviewingPublication = ref(false)
const publicationBusy = ref(false)
const publicationConfirmed = ref(false)
async function publicationAction(decision?: 'approve' | 'reject') {
  if (publicationBusy.value) return
  publicationBusy.value = true
  try {
    const publication = runQ.data.value?.publication
    await api(`/api/agent-runs/${route.params.id}/publication`, { method: 'POST', body: decision && publication
      ? { action: 'decide', id: publication.id, digest: publication.digest, decision }
      : { action: 'prepare' } })
    reviewingPublication.value = !decision
    publicationConfirmed.value = false
    await runQ.refetch()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }); await runQ.refetch() }
  finally { publicationBusy.value = false }
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
      <details v-if="runQ.data.value?.factoryCalls?.length" class="space-y-3 rounded-lg border border-default p-4">
        <summary class="cursor-pointer font-medium">Private Factory tool audit</summary>
        <article v-for="call in runQ.data.value.factoryCalls" :key="call.callId" class="space-y-2 border-t border-default pt-3">
          <p class="break-all text-sm">{{ call.callId }} · {{ call.status }} · {{ new Date(call.createdAt).toLocaleString() }}</p>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{{ call.argumentsJson }}</pre>
          <p v-if="call.error" class="break-words text-sm text-warning">{{ call.error }}</p>
        </article>
      </details>
      <AgentsFactoryReview v-if="run.hasFactory" :run-id="run.id" :active="['queued', 'running'].includes(run.status)" />
      <section v-if="runQ.data.value?.security" class="space-y-3">
        <h2 class="text-sm font-medium">Tool security</h2>
        <UAlert color="neutral" title="Sensitive actions require review" :description="runQ.data.value.security.untrustedContext ? 'This conversation contains untrusted content. Software Factory operations use the exact private reviews above. Other model-selected Server writes and outbound integrations remain blocked, including across retries.' : 'Software Factory operations require exact private review above. Other model-selected Server writes and outbound integrations remain blocked.'" />
        <p class="text-xs text-muted">Run content is private to you. Shared chat and Task views receive only a safe notice. These are context-policy decisions; an allowed decision does not mean the operation completed.</p>
        <ul v-if="runQ.data.value.security.decisions.length" class="space-y-1 text-xs text-muted">
          <li v-for="(decision, index) in runQ.data.value.security.decisions.slice(-20)" :key="index" class="break-all">{{ decision.tool }} · {{ decision.effect }} · {{ decision.decision }}<span v-if="decision.untrustedContext"> · Untrusted context</span><span v-if="decision.decision === 'blocked'"> · Human review required</span></li>
        </ul>
      </section>
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
      <section v-if="run.resultText" class="space-y-2"><h2 class="text-sm font-medium">Result</h2><ChatMarkdownView :content="run.resultText" class="text-sm text-default" /></section>
      <section v-if="run.status === 'completed' && run.resultText?.trim() && can(Permission.approveAgentActions)" class="space-y-3 rounded-lg border border-default p-4">
        <h2 class="text-sm font-medium">Share result</h2>
        <p class="text-xs text-muted">The result above is private. Sharing posts the exact reviewed text as this Agent in the original conversation. Factory workspace and GitHub publication actions have their own exact reviews.</p>
        <p v-if="run.resultText.trim().length > 2000" class="text-sm text-muted">Results over 2000 characters cannot be shared through this review.</p>
        <template v-else-if="runQ.data.value?.publication && ['completed', 'executing', 'uncertain'].includes(runQ.data.value.publication.status)">
          <p class="text-sm">Publication: {{ runQ.data.value.publication.status }}</p>
          <p v-if="runQ.data.value.publication.status !== 'completed'" class="text-xs text-warning">Inspect the conversation before taking any further action. This publication will not be retried.</p>
        </template>
        <template v-else>
          <UButton label="Review sharing" color="neutral" variant="outline" :loading="publicationBusy" @click="publicationAction()" />
          <div v-if="reviewingPublication && runQ.data.value?.publication?.status === 'pending'" class="space-y-3">
            <p class="break-words text-sm">Conversation: {{ runQ.data.value.publication.channelName }}</p>
            <p class="break-all text-xs text-muted">{{ runQ.data.value.publication.channelId }}</p>
            <p class="text-sm text-warning">{{ runQ.data.value.publication.audience }}</p>
            <p class="text-xs text-muted">Approval expires {{ new Date(runQ.data.value.publication.expiresAt).toLocaleString() }}. It applies only to this text and conversation.</p>
            <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-default p-3 text-sm">{{ runQ.data.value.publication.content }}</pre>
            <UCheckbox v-model="publicationConfirmed" label="I reviewed this exact text and its audience and approve sharing it." />
            <div class="flex flex-wrap gap-2">
              <UButton label="Approve and publish" :disabled="!publicationConfirmed" :loading="publicationBusy" @click="publicationAction('approve')" />
              <UButton label="Reject" color="neutral" variant="outline" :loading="publicationBusy" @click="publicationAction('reject')" />
            </div>
          </div>
        </template>
      </section>
      <section v-if="runQ.data.value?.publicationHistory?.length" class="space-y-2">
        <h2 class="text-sm font-medium">Publication review history</h2>
        <ol class="space-y-1 text-xs text-muted">
          <li v-for="entry in runQ.data.value.publicationHistory" :key="entry.id" class="break-all">{{ entry.status }}<span v-if="entry.decidedAt"> · {{ new Date(entry.decidedAt).toLocaleString() }} · {{ entry.decidedBy }}</span></li>
        </ol>
      </section>
      <section v-if="runQ.data.value?.events?.length" class="space-y-2">
        <h2 class="text-sm font-medium">Activity</h2>
        <ol class="space-y-2"><li v-for="entry in runQ.data.value.events" :key="entry.sequence" class="rounded border border-default p-3 text-sm">
          <span class="text-xs text-muted">{{ new Date(entry.createdAt).toLocaleString() }} · {{ entry.event.type }}</span>
          <p class="whitespace-pre-wrap break-words">{{ entry.event.message || entry.event.text || entry.event.name }}</p>
          <p v-if="entry.event.purpose" class="text-xs text-muted">Selection purpose: {{ entry.event.purpose }}</p>
        </li></ol>
      </section>
      <UButton v-if="runQ.data.value?.canRetry && ['failed', 'cancelled'].includes(run.status)" label="Retry run" icon="i-ph-arrow-clockwise" :loading="retrying" @click="retryRun" />
      <UButton v-if="run.hasFiles && can(Permission.useComputer)" label="Download working files" icon="i-ph-download" color="neutral" variant="outline" :loading="downloading" @click="downloadFiles" />
      <UButton v-if="runQ.data.value?.canCancel && ['queued', 'running'].includes(run.status)" label="Stop run" color="neutral" variant="outline" :loading="cancelling" @click="cancel" />
    </template>
    </main>
  </div>
</template>
