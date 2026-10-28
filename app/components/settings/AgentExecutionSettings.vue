<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery } from '@tanstack/vue-query'
import { defaultAgentExecutionPolicy, type AgentExecutionPolicy } from '~~/shared/agent-execution-policy'
const props = defineProps<{ serverId: string }>()
const { api } = useApi(), toast = useToast()
const open = ref(false), busy = ref(false)
const form = reactive(defaultAgentExecutionPolicy())
const query = useQuery({ queryKey: computed(() => ['agent-execution', props.serverId]), queryFn: () => api<{ policy: AgentExecutionPolicy }>(`/api/servers/${props.serverId}/agent-execution`) })
const policy = computed(() => query.data.value?.policy)
const limits = [
  { key: 'maxSteps', label: 'Steps per run', min: 1, max: 2048 },
  { key: 'maxModelCalls', label: 'Model calls per run', min: 1, max: 2048 },
  { key: 'maxToolCalls', label: 'Tool calls per run', min: 1, max: 32768 },
  { key: 'maxTokens', label: 'Tokens per run', min: 16000, max: 20000000 },
  { key: 'maxDurationMs', label: 'Run duration (milliseconds)', min: 60000, max: 86400000 },
  { key: 'dailyTokens', label: 'Tokens per agent in 24 hours', min: 16000, max: 200000000 },
  { key: 'dailyRuns', label: 'Runs per agent in 24 hours', min: 1, max: 10000 },
  { key: 'repeatedToolCalls', label: 'Identical tool calls before stopping', min: 2, max: 50 },
  { key: 'maxChildRuns', label: 'Delegated runs per original run', min: 0, max: 256 },
  { key: 'maxDepth', label: 'Maximum delegation depth', min: 1, max: 16 },
  { key: 'workspaceActions', label: 'Actions per task workspace', min: 10, max: 32768 },
  { key: 'workspaceRuntimeMs', label: 'Task command runtime (milliseconds)', min: 60000, max: 86400000 },
  { key: 'workspacePublications', label: 'Draft PR updates per task workspace', min: 1, max: 1000 },
] as const
function edit() { Object.assign(form, policy.value); open.value = true }
async function save() {
  busy.value = true
  try { await api(`/api/servers/${props.serverId}/agent-execution`, { method: 'PUT', body: { ...form } }); await query.refetch(); open.value = false }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
</script>
<template>
  <div class="space-y-5">
    <p class="text-sm text-muted">Agents work within the current permissions of both the agent and the person who starts the work. Project policies keep those permissions attached to the right project.</p>
    <LayoutLoadError v-if="query.error.value" message="Execution settings did not load." :retry="query.refetch" />
    <button v-if="policy" class="flex w-full items-center justify-between gap-4 rounded-lg border border-default p-4 text-left hover:bg-elevated" @click="edit">
      <span><span class="block font-medium">{{ policy.mode === 'role' ? 'Autonomous within granted permissions' : 'Review writes and outbound calls' }}</span><span class="mt-1 block text-sm text-muted">{{ policy.maxModelCalls }} model calls · {{ policy.maxToolCalls }} tool calls · {{ policy.maxTokens.toLocaleString() }} tokens · {{ policy.maxDurationMs / 3600000 }} hours per run</span></span><UIcon name="i-ph-caret-right" class="size-4 shrink-0" />
    </button>
    <SettingsEditor v-model:open="open" back="Agents" title="Agent execution" description="These settings apply to new runs. Existing runs retain their admitted limits. Revoking roles or project access stops new actions immediately.">
      <template #body><form class="space-y-5" @submit.prevent="save">
        <UFormField label="Execution mode"><USelect v-model="form.mode" :items="[{ label: 'Autonomous within granted permissions', value: 'role' }, { label: 'Review writes and outbound calls', value: 'review' }]" class="w-full" /></UFormField>
        <p class="text-sm text-muted">Review mode pauses compute operations for approval and blocks other writes and outbound calls. Autonomous mode allows only tools covered by the run and current permissions. Merge and release tools are not available.</p>
        <UFormField v-for="limit in limits" :key="limit.key" :label="limit.label"><UInput v-model.number="form[limit.key]" type="number" :min="limit.min" :max="limit.max" required class="w-full" /></UFormField>
        <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Save execution settings" :loading="busy" /></div>
      </form></template>
    </SettingsEditor>
  </div>
</template>
