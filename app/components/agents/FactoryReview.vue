<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { FactoryAction, FactorySnapshot } from '~~/shared/software-factory'
import { Permission } from '~~/shared/permissions'
const props = defineProps<{ runId: string; active: boolean }>(), { api } = useApi(), { can } = useRoleGrants(), toast = useToast()
const query = useQuery({ queryKey: computed(() => ['factory', props.runId]), queryFn: () => api<{ actions: FactoryAction[]; workspace: { repository: string; baseBranch: string; branch: string; connectionId: string; taskId: string; agentId: string; initiatedBy: string; id: string; status: string; nodeId: string; commands: number; runtimeMs: number; publicationCount: number; snapshot: FactorySnapshot | null; snapshotDigest: string | null; pull: { url: string; number: number; commit: string } | null } | null }>(`/api/agent-runs/${props.runId}/factory`), refetchInterval: () => props.active ? 2000 : false })
watch(() => props.active, active => { if (!active) void query.refetch() })
const feedback = ref<{ state?: string; commit?: string; providerMergeState?: string; previewState?: string; previewReason?: string; checks?: { name: string; state: string; url: string | null }[]; previews?: { state: string; url: string | null; source: string }[] } | null>(null)
async function refreshFeedback() {
  busy.value = true
  try { feedback.value = await api(`/api/agent-runs/${props.runId}/factory-feedback`) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
const confirmed = ref<Record<string, boolean>>({}), busy = ref(false)
async function decide(action: FactoryAction, decision: 'approve' | 'reject') {
  busy.value = true
  try { await api(`/api/agent-runs/${action.runId}/factory`, { method: 'POST', body: { id: action.id, digest: action.digest, decision } }); await query.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }); await query.refetch() }
  finally { busy.value = false }
}
</script>
<template>
  <section v-if="query.data.value?.workspace || query.error.value" class="space-y-4 rounded-lg border border-default p-4">
    <h2 class="font-medium">Software Factory</h2>
    <LayoutLoadError v-if="query.error.value" message="Private workspace actions did not load." :retry="query.refetch" />
    <template v-if="query.data.value?.workspace">
      <p class="break-all text-sm">Repository: {{ query.data.value.workspace.repository }} · {{ query.data.value.workspace.baseBranch }} → {{ query.data.value.workspace.branch }}</p>
      <p class="break-all text-xs text-muted">Task {{ query.data.value.workspace.taskId }} · Agent {{ query.data.value.workspace.agentId }} · Initiator {{ query.data.value.workspace.initiatedBy }} · Connection {{ query.data.value.workspace.connectionId }} · Node {{ query.data.value.workspace.nodeId }}</p>
      <p class="break-all text-sm">Workspace {{ query.data.value.workspace.id }} · {{ query.data.value.workspace.status }}</p>
      <p class="text-xs text-muted">{{ query.data.value.workspace.commands }}/50 operations · {{ Math.ceil(query.data.value.workspace.runtimeMs / 1000) }}/3600 seconds · {{ query.data.value.workspace.publicationCount }}/10 publications. Action requests expire with their Run. This review is private to you.</p>
      <a v-if="query.data.value.workspace.pull" :href="query.data.value.workspace.pull.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">Open canonical GitHub PR #{{ query.data.value.workspace.pull.number }}</a>
      <UButton v-if="query.data.value.workspace.pull" label="Refresh existing CI and Preview" color="neutral" variant="outline" :loading="busy" @click="refreshFeedback" />
      <div v-if="feedback" class="space-y-2 text-sm">
        <p class="break-all">CI: {{ feedback.state }} · Head {{ feedback.commit }} · GitHub merge state: {{ feedback.providerMergeState }}</p>
        <p>Preview: {{ feedback.previewState }} {{ feedback.previewReason }}</p>
        <ul class="space-y-1"><li v-for="check in feedback.checks" :key="check.name"><a v-if="check.url" :href="check.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{ check.name }}</a><span v-else>{{ check.name }}</span> · {{ check.state }}</li></ul>
        <ul class="space-y-1"><li v-for="(preview, index) in feedback.previews" :key="index"><a v-if="preview.url" :href="preview.url" target="_blank" rel="noopener noreferrer" class="text-primary underline">{{ preview.source }}</a><span v-else>{{ preview.source }}</span> · {{ preview.state }}</li></ul>
      </div>
      <div v-if="query.data.value.workspace.snapshot" class="space-y-2">
        <p class="break-all text-xs">Base: {{ query.data.value.workspace.snapshot.baseSha }}<br>Head: {{ query.data.value.workspace.snapshot.headSha }}<br>Snapshot digest: {{ query.data.value.workspace.snapshotDigest }}</p>
        <details><summary class="cursor-pointer text-sm">Review exact diff, commits and test evidence</summary><pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{{ query.data.value.workspace.snapshot.diff }}</pre><pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{{ JSON.stringify(query.data.value.workspace.snapshot.commits.map(commit => ({ sha: commit.sha, parents: commit.parents, message: commit.message })), null, 2) }}
{{ JSON.stringify(query.data.value.workspace.snapshot.evidence, null, 2) }}</pre></details>
      </div>
      <article v-for="action in query.data.value.actions" :key="action.id" class="space-y-2 rounded border border-default p-3">
        <p class="text-sm">{{ action.request.operation }} · {{ action.status }}</p>
        <p class="break-all text-xs text-muted">Action {{ action.id }} · Run {{ action.runId }} · expires {{ new Date(action.expiresAt).toLocaleString() }}</p>
        <p class="break-all text-xs text-muted">Image {{ action.computeImage }} · Workspace revision {{ action.workspaceRevision }} · 1 CPU, 1 GiB memory, 128 processes, {{ Math.round(action.diskBytes / 1048576) }} MiB hard disk capacity; commands up to 120 seconds.</p>
        <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{{ JSON.stringify(action.request, null, 2) }}</pre>
        <template v-if="action.status === 'pending' && can(Permission.approveAgentActions)">
          <p class="text-xs text-warning">Approval applies only to these arguments, Task, repository snapshot and Node. Commands can change or delete workspace files. Approved network hosts may receive source data. Publication writes the exact reviewed commits to a dedicated GitHub branch and draft PR; it grants no merge or release.</p>
          <UCheckbox v-model="confirmed[action.id]" label="I reviewed this exact operation, destination, changes and effects." />
          <div class="flex flex-wrap gap-2"><UButton label="Approve exact action" :disabled="!confirmed[action.id]" :loading="busy" @click="decide(action, 'approve')" /><UButton label="Reject" color="neutral" variant="outline" :loading="busy" @click="decide(action, 'reject')" /></div>
        </template>
        <p v-if="action.status === 'uncertain'" class="text-sm text-warning">Outcome uncertain. Inspect the Node and GitHub before doing further work. This operation will not be replayed.</p>
        <details v-if="action.result"><summary class="cursor-pointer text-sm">Private operation receipt</summary><pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{{ JSON.stringify(action.result, null, 2) }}</pre></details>
      </article>
    </template>
  </section>
</template>
