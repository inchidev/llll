<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { FactoryApproval, ReviewDiff } from '~~/shared/software-factory'
import { Permission } from '~~/shared/permissions'
import { GIT_MERGE_LABELS, type ProjectGitFlow } from '~~/shared/project-factory'
type TaskBox = { id: string; taskId: string; status: string; nodeId: string; repository: string; baseBranch: string; baseSha: string; branch: string; headSha: string | null; runtimeMs: number
  gitFlow: ProjectGitFlow; pushedSha: string | null; publicationCount: number; updatedAt: string; pull: { url: string; number: number; commit: string } | null }
const props = defineProps<{ runId: string; active: boolean }>(), { api } = useApi(), { can } = useRoleGrants(), toast = useToast()
const query = useQuery({ queryKey: computed(() => ['factory', props.runId]), queryFn: () => api<{ box: TaskBox | null; approvals: FactoryApproval[] }>(`/api/agent-runs/${props.runId}/factory`), refetchInterval: () => props.active ? 2000 : false })
watch(() => props.active, active => { if (!active) void query.refetch() })
const box = computed(() => query.data.value?.box ?? null)
const busy = ref(false), confirmed = ref<Record<string, boolean>>({})
const boxStates: Record<string, string> = { new: 'Not started yet', queued: 'Waiting for a free box', starting: 'Starting', running: 'Working', idle: 'Idle', stopped: 'Stopped, its disk kept', released: 'Released with its Task', failed: 'Could not start' }
const statuses: Record<string, string> = { pending_diff: 'Preparing the diff', pending: 'Waiting for your decision', approved: 'Approved', publishing: 'Pushing', completed: 'Published', rejected: 'Rejected', expired: 'Expired', failed: 'Failed', uncertain: 'Outcome uncertain' }

const feedback = ref<{ state?: string; commit?: string; providerMergeState?: string; previewState?: string; previewReason?: string; checks?: { name: string; state: string; url: string | null }[]; previews?: { state: string; url: string | null; source: string }[] } | null>(null)
async function refreshFeedback() {
  busy.value = true
  try { feedback.value = await api(`/api/agent-runs/${props.runId}/factory-feedback`) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
const exported = ref<{ remote: string; token: string; expiresAt: string; instruction: string } | null>(null)
async function exportSource() {
  busy.value = true
  try { exported.value = await api(`/api/agent-runs/${props.runId}/factory-export`, { method: 'POST' }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
/** A push's commits and diff, read from storage when the person opens them. */
const reviews = ref<Record<string, ReviewDiff>>({})
async function loadReview(approval: FactoryApproval) {
  if (reviews.value[approval.id]) return
  try { reviews.value[approval.id] = await api<ReviewDiff>(`/api/agent-runs/${props.runId}/factory-review`, { query: { approval: approval.id } }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}
async function decide(approval: FactoryApproval, decision: 'approve' | 'reject') {
  busy.value = true
  try { await api(`/api/agent-runs/${approval.runId}/factory`, { method: 'POST', body: { id: approval.id, digest: approval.digest, decision } }); await query.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }); await query.refetch() }
  finally { busy.value = false }
}
const message = (approval: FactoryApproval) => (approval.result as { message?: string } | null)?.message ?? null
const heading = (approval: FactoryApproval) => approval.kind === 'plan' ? 'Plan' : approval.kind === 'window' ? `Network window to ${approval.request.host}`
  : approval.kind === 'merge' ? `Merge of pull request #${approval.request.number} by ${approval.request.by === 'agent' ? 'the Agent' : 'a person'}` : approval.request.title
const status = (approval: FactoryApproval) => approval.kind === 'merge' ? ({ publishing: 'Merging', completed: 'Merged', failed: 'Refused', uncertain: 'Outcome uncertain' } as Record<string, string>)[approval.status] ?? approval.status
  : approval.kind === 'publish' && approval.status === 'completed' && approval.request.direct ? 'Pushed' : statuses[approval.status] ?? approval.status
const windowStatus = (approval: FactoryApproval) => approval.kind === 'window' && approval.status === 'approved' ? approval.expiresAt > new Date().toISOString() ? `Open until ${new Date(approval.expiresAt).toLocaleString()}` : 'Closed' : null
const warnings: Record<string, string> = {
  plan: 'Approving lets the agent push its branch and update the Task’s draft pull request without asking each time, until it proposes a new plan. A window for a host or secret the plan names then opens without asking. It grants no merge or release.',
  window: 'Approving lets the agent’s box reach this host for the stated time. Each named secret is put in only on requests to this host; the agent never sees its value.',
  publish: 'Approving pushes exactly this commit to the Task’s own branch and opens or updates its draft pull request. It grants no merge or release.',
  direct: 'Approving pushes exactly this commit straight to the base branch, as a fast-forward, without a pull request. Whatever builds from that branch takes it from there.',
}
const confirmations: Record<string, string> = { plan: 'I reviewed this plan.', window: 'I reviewed this host and the secrets it may receive.', publish: 'I reviewed this commit and its diff.' }
const approveLabels: Record<string, string> = { plan: 'Approve plan', window: 'Open window', publish: 'Approve push' }
</script>
<template>
  <section v-if="box || query.error.value" class="space-y-4 rounded-lg border border-default p-4">
    <h2 class="font-medium">The Agent’s box</h2>
    <LayoutLoadError v-if="query.error.value" message="The Task’s box did not load." :retry="query.refetch" />
    <template v-if="box">
      <p class="text-sm">{{ boxStates[box.status] ?? box.status }} · {{ Math.ceil(box.runtimeMs / 60000) }} minutes of work · {{ box.publicationCount }} {{ box.publicationCount === 1 ? 'push' : 'pushes' }}</p>
      <p class="break-all text-sm">{{ box.repository }} · {{ box.gitFlow.merge === 'direct_push' ? `pushes straight to ${box.baseBranch}` : `${box.baseBranch} → ${box.branch}` }} · {{ GIT_MERGE_LABELS[box.gitFlow.merge].label }}</p>
      <p class="break-all font-mono text-xs text-muted">Base {{ box.baseSha }}<template v-if="box.headSha"> · last saved {{ box.headSha }}</template></p>
      <AgentsTaskMerge v-if="box.pull || box.pushedSha" :key="`${box.taskId}-${box.pull?.commit ?? box.pushedSha}`" :task-id="box.taskId" />
      <div class="flex flex-wrap gap-2">
        <UButton v-if="box.pull" label="Refresh checks and preview" color="neutral" variant="outline" :loading="busy" @click="refreshFeedback" />
        <UButton label="Export private Task code" color="neutral" variant="outline" :loading="busy" @click="exportSource" />
      </div>
      <div v-if="exported" class="space-y-2 rounded border border-default p-3">
        <p class="text-xs text-muted">{{ exported.instruction }} Expires {{ new Date(exported.expiresAt).toLocaleString() }}.</p>
        <code class="block select-all break-all text-xs">{{ exported.remote }}</code>
        <details><summary class="cursor-pointer text-sm">Show private read token</summary><code class="block select-all break-all text-xs">{{ exported.token }}</code></details>
      </div>
      <div v-if="feedback" class="space-y-2 text-sm">
        <p class="break-all">Checks: {{ feedback.state }} · Head {{ feedback.commit }} · Merge state: {{ feedback.providerMergeState }}</p>
        <p>Preview: {{ feedback.previewState }} {{ feedback.previewReason }}</p>
        <ul class="space-y-1"><li v-for="check in feedback.checks" :key="check.name"><a v-if="check.url" :href="check.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{ check.name }}</a><span v-else>{{ check.name }}</span> · {{ check.state }}</li></ul>
        <ul class="space-y-1"><li v-for="(preview, index) in feedback.previews" :key="index"><a v-if="preview.url" :href="preview.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{ preview.source }}</a><span v-else>{{ preview.source }}</span> · {{ preview.state }}</li></ul>
      </div>
      <article v-for="approval in query.data.value?.approvals" :key="approval.id" class="space-y-2 rounded border border-default p-3">
        <p class="text-sm font-medium">{{ heading(approval) }} · {{ windowStatus(approval) ?? status(approval) }}</p>
        <p class="text-xs text-muted">{{ new Date(approval.createdAt).toLocaleString() }}<template v-if="approval.decidedAt"> · decided {{ new Date(approval.decidedAt).toLocaleString() }}</template></p>
        <template v-if="approval.kind === 'plan'">
          <p class="whitespace-pre-wrap text-sm">{{ approval.request.summary }}</p>
          <ol class="list-decimal space-y-1 ps-5 text-sm"><li v-for="(step, index) in approval.request.steps" :key="index">{{ step }}</li></ol>
          <p v-if="approval.request.hosts?.length" class="break-all text-xs text-muted">Hosts: {{ approval.request.hosts.join(', ') }}</p>
          <p v-if="approval.request.secrets?.length" class="break-all text-xs text-muted">Secrets: {{ approval.request.secrets.join(', ') }}</p>
        </template>
        <template v-else-if="approval.kind === 'window'">
          <p class="whitespace-pre-wrap break-words text-sm">{{ approval.request.reason }}</p>
          <p class="text-xs text-muted">{{ approval.request.minutes }} minutes<template v-if="approval.request.secrets?.length"> · secrets {{ approval.request.secrets.join(', ') }}</template></p>
        </template>
        <p v-else-if="approval.kind === 'merge'" class="break-all font-mono text-xs">{{ approval.request.sha }} · {{ approval.request.method }}</p>
        <template v-else>
          <p class="break-all font-mono text-xs">{{ approval.request.sha }} → {{ approval.request.ref }}<span v-if="approval.request.direct" class="font-sans text-warning"> · base branch, no pull request</span></p>
          <p v-if="approval.request.body" class="whitespace-pre-wrap break-words text-sm text-muted">{{ approval.request.body }}</p>
          <details v-if="approval.diff" @toggle="loadReview(approval)">
            <summary class="cursor-pointer text-sm">Review commits and diff</summary>
            <template v-if="reviews[approval.id]">
              <ul class="mt-2 space-y-1 text-xs"><li v-for="item in reviews[approval.id]!.commits" :key="item.sha" class="break-all"><span class="font-mono">{{ item.sha.slice(0, 12) }}</span> {{ item.subject }}</li></ul>
              <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{{ reviews[approval.id]!.stat }}</pre>
              <pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{{ reviews[approval.id]!.patch }}</pre>
              <p v-if="reviews[approval.id]!.truncated" class="text-xs text-warning">The diff is longer than shown. Approve only what you have read, or review the commit in a clone.</p>
            </template>
          </details>
        </template>
        <template v-if="approval.status === 'pending' && can(Permission.approveAgentActions)">
          <p class="text-xs text-warning">{{ warnings[approval.request.direct ? 'direct' : approval.kind] }}</p>
          <UCheckbox v-model="confirmed[approval.id]" :label="confirmations[approval.kind]" />
          <div class="flex flex-wrap gap-2"><UButton :label="approveLabels[approval.kind]" :disabled="!confirmed[approval.id]" :loading="busy" @click="decide(approval, 'approve')" /><UButton label="Reject" color="neutral" variant="outline" :loading="busy" @click="decide(approval, 'reject')" /></div>
        </template>
        <p v-if="message(approval)" class="text-sm" :class="approval.status === 'uncertain' ? 'text-warning' : 'text-muted'">{{ message(approval) }}</p>
      </article>
    </template>
  </section>
</template>
