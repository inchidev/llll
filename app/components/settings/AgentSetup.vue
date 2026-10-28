<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { AgentModelOption } from '~~/shared/agent-providers'
import type { GitConnection } from '~~/shared/git-connections'
import type { CodeEnvironment } from '~~/shared/code-environments'
import type { ComputeNode } from '~~/shared/software-factory'

// Shares query keys with the settings it links to, so finishing a step there updates this list.
const props = defineProps<{ serverId: string; agentCount: number }>()
const emit = defineEmits<{ models: []; section: [section: 'environments' | 'compute']; createAgent: [] }>()
const { api } = useApi()
const models = useQuery({ queryKey: computed(() => ['agent-provider-model-options', props.serverId, '']), queryFn: () => api<{ models: AgentModelOption[] }>(`/api/servers/${props.serverId}/agent-providers/model-options`, { query: { search: '' } }) })
const git = useQuery({ queryKey: ['git-connections'], queryFn: () => api<{ connections: GitConnection[] }>('/api/git-connections') })
const repositories = useQuery({ queryKey: ['code-environments'], queryFn: () => api<{ environments: CodeEnvironment[] }>('/api/code-environments') })
const nodes = useQuery({ queryKey: ['compute-nodes'], queryFn: () => api<{ nodes: ComputeNode[] }>('/api/compute-nodes') })

const steps = computed(() => [
  { key: 'model', title: 'Connect a model', description: 'OpenRouter, an Anthropic API key or ChatGPT. Keys stay encrypted on this Server.', done: Boolean(models.data.value?.models.length), action: 'Add provider', go: () => emit('models') },
  { key: 'github', title: 'Connect GitHub', description: 'A dedicated GitHub App for the repositories agents may work on.', done: Boolean(git.data.value?.connections.some(connection => connection.enabled)), action: 'Connect', go: () => emit('section', 'environments') },
  { key: 'repository', title: 'Add a repository', description: 'Choose the source repository and base branch Tasks start from.', done: Boolean(repositories.data.value?.environments.some(environment => environment.enabled)), action: 'Add', go: () => emit('section', 'environments') },
  { key: 'compute', title: 'Add compute', description: 'Containers on your Cloudflare account, or a Compute Node on your VPS.', done: Boolean(nodes.data.value?.nodes.some(node => node.enabled)), action: 'Add', go: () => emit('section', 'compute') },
  { key: 'agent', title: 'Create an agent', description: 'Give it a Role with Use a computer and Propose code, then assign it a repository Task.', done: props.agentCount > 0, action: 'Create', go: () => emit('createAgent') },
])
const pending = computed(() => models.isPending.value || git.isPending.value || repositories.isPending.value || nodes.isPending.value)
const remaining = computed(() => steps.value.filter(step => !step.done).length)
const next = computed(() => steps.value.find(step => !step.done)?.key)
</script>

<template>
  <section v-if="!pending && remaining" aria-labelledby="agent-setup-title" class="mb-8 rounded-lg border border-default p-5">
    <div class="flex items-baseline justify-between gap-4">
      <h3 id="agent-setup-title" class="font-medium text-highlighted">Set up agents that work on code</h3>
      <span class="shrink-0 text-xs tabular-nums text-muted">{{ steps.length - remaining }} of {{ steps.length }} done</span>
    </div>
    <p class="mt-1 text-sm text-muted">Agents can chat with only a model. To take a Task to a draft pull request, they also need these.</p>
    <ol class="mt-4 divide-y divide-default">
      <li v-for="step in steps" :key="step.key" class="flex items-center gap-3 py-3">
        <UIcon :name="step.done ? 'i-ph-check-circle' : 'i-ph-circle'" class="size-5 shrink-0" :class="step.done ? 'text-primary' : 'text-dimmed'" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium" :class="step.done ? 'text-muted line-through' : 'text-highlighted'">{{ step.title }}</p>
          <p v-if="!step.done" class="mt-0.5 text-xs text-muted">{{ step.description }}</p>
        </div>
        <UButton v-if="!step.done" :label="step.action" size="sm" :color="step.key === next ? 'primary' : 'neutral'" :variant="step.key === next ? 'solid' : 'outline'" @click="step.go()" />
      </li>
    </ol>
  </section>
</template>
