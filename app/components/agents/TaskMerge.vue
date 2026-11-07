<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ProjectGitFlow } from '~~/shared/project-factory'
import { GIT_METHOD_LABELS } from '~~/shared/project-factory'
type Pull = { number: number; commit: string; branch: string; url: string; pushedAt?: string; merged?: { sha: string | null; method: string; at: string; by: 'person' | 'agent' } }
type MergeState = { box: { id: string; repository: string; baseBranch: string; branch: string; pushedSha: string | null; pull: Pull | null } | null
  gitFlow: ProjectGitFlow | null; canMerge: boolean; ready: boolean; unchecked: boolean; reason: string | null; message?: string
  /** Set while a head with no checks reported is too new to tell: CI may not have registered them yet. */
  checksRegisterUntil?: string | null }
/** The Task's code where its pull request is shown: the pull request and its Merge, or the commit a direct push sent. */
const props = defineProps<{ taskId: string }>()
const { api } = useApi(), toast = useToast()
// Right after a push, "no checks" may only mean CI has not registered them: read again once the grace ends.
const query = useQuery({ queryKey: computed(() => ['task-merge', props.taskId]), queryFn: () => api<MergeState>(`/api/tasks/${props.taskId}/merge`),
  refetchInterval: current => {
    const until = Date.parse(current.state.data?.checksRegisterUntil ?? '')
    return Number.isFinite(until) ? Math.min(Math.max(until - Date.now() + 1000, 5000), 30000) : false
  } })
const state = computed(() => query.data.value)
const pull = computed(() => state.value?.box?.pull ?? null)
const busy = ref(false), confirmed = ref(false)
const merging = computed(() => Boolean(pull.value && !pull.value.merged && state.value?.gitFlow && state.value.gitFlow.merge !== 'direct_push'))
async function merge() {
  if (!pull.value) return
  busy.value = true
  try {
    const result = await api<MergeState>(`/api/tasks/${props.taskId}/merge`, { method: 'POST', body: { sha: pull.value.commit } })
    toast.add({ title: `Pull request #${pull.value.number} merged`, description: result.message, color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false; confirmed.value = false; await query.refetch() }
}
</script>
<template>
  <div v-if="state?.box" class="space-y-2 text-sm">
    <template v-if="pull">
      <div class="flex flex-wrap items-center gap-2">
        <UButton :to="pull.url" target="_blank" size="sm" color="neutral" variant="outline" icon="i-ph-git-pull-request" :label="`Pull request #${pull.number}`" />
        <UBadge v-if="pull.merged" color="success" variant="subtle">Merged {{ new Date(pull.merged.at).toLocaleString() }}</UBadge>
      </div>
      <p class="break-all font-mono text-xs text-muted">{{ pull.branch }} → {{ state.box.baseBranch }} · head {{ pull.commit.slice(0, 12) }}<template v-if="pull.merged?.sha"> · merge {{ pull.merged.sha.slice(0, 12) }}</template></p>
      <template v-if="merging">
        <p v-if="state.reason" :class="state.unchecked ? 'text-warning' : 'text-muted'">{{ state.reason }}</p>
        <template v-if="state.canMerge">
          <UCheckbox v-if="state.ready" v-model="confirmed" :label="`Merge #${pull.number} into ${state.box.baseBranch} by ${GIT_METHOD_LABELS[state.gitFlow!.method].toLowerCase()}${state.unchecked ? ' without checks' : ''}`" />
          <div class="flex flex-wrap gap-2">
            <UButton label="Merge" icon="i-ph-git-merge" :disabled="!state.ready || !confirmed" :loading="busy" :title="state.ready ? undefined : state.reason ?? undefined" @click="merge" />
            <UButton label="Check again" color="neutral" variant="ghost" :loading="query.isFetching.value" @click="query.refetch()" />
          </div>
        </template>
        <p v-else class="text-xs text-muted">A person who may approve Agent actions in this project merges it.</p>
      </template>
    </template>
    <p v-else-if="state.box.pushedSha" class="break-all">Pushed to {{ state.box.baseBranch }}: <span class="font-mono">{{ state.box.pushedSha }}</span> <span class="text-muted">· no pull request under this Project’s Git flow</span></p>
  </div>
</template>
