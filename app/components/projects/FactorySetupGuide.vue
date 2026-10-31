<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { FactoryChecklist, FactoryChecklistStep } from '~~/server/utils/factory-checklist'

// The Server works out each step, so finishing one anywhere (Settings, a project, a task) ticks it here.
const { api } = useApi(), nav = useNavActions()
const checklist = useQuery({ queryKey: ['factory-checklist'], queryFn: () => api<FactoryChecklist>('/api/factory/checklist'), refetchOnWindowFocus: true })
watch([nav.serverSettingsOpen, nav.createProjectOpen, nav.createAgentOpen], (open, was) => { if (open.some((value, index) => !value && was[index])) void checklist.refetch() })

// Settings → Agents shows this list too; steps done outside Settings close it first.
function leave<T>(go: () => T) { nav.serverSettingsOpen.value = false; return go() }
const project = () => leave(() => checklist.data.value?.projectId ? navigateTo(`/factory/projects/${checklist.data.value.projectId}`) : undefined)
const steps: { key: FactoryChecklistStep; title: string; description: string; action: string; go: () => unknown }[] = [
  { key: 'models', title: 'Connect a model', description: 'OpenRouter, an Anthropic API key or ChatGPT. Keys stay encrypted on this Server.', action: 'Add provider', go: () => nav.openServerSettings('models') },
  { key: 'agent', title: 'Create an agent', description: 'Name it and pick its model. Project access comes later, per project.', action: 'Create agent', go: () => leave(() => { nav.createAgentOpen.value = true }) },
  { key: 'git', title: 'Connect GitHub or Gitea', description: 'A GitHub App or Gitea bot account limited to the repositories you choose.', action: 'Connect', go: () => nav.openServerSettings('environments') },
  { key: 'computer', title: 'Add a computer', description: 'Where agents run commands: Lizard, Cloudflare Containers or a Compute Node on your VPS.', action: 'Add computer', go: () => nav.openServerSettings('compute') },
  { key: 'project', title: 'Create a project', description: 'It gathers a repository, its tasks and who may work on them. The first one brings a task board.', action: 'Create project', go: () => leave(() => { nav.createProjectOpen.value = true }) },
  { key: 'repository', title: 'Connect a repository', description: 'Pick the repository, base branch, required checks and preview domains in the project.', action: 'Open project', go: () => project() },
  { key: 'access', title: 'Give the agent project access', description: 'The Developer policy lets it run tasks, use the computer and open pull requests in that project.', action: 'Open project', go: () => project() },
  { key: 'run', title: 'Run a first task', description: 'Describe the change, assign the agent and choose Create and run. It ends in a draft pull request.', action: 'New task', go: () => leave(() => navigateTo('/tasks')) },
]
const remaining = computed(() => steps.filter(step => !checklist.data.value?.steps[step.key]).length)
const next = computed(() => steps.find(step => !checklist.data.value?.steps[step.key])?.key)
</script>

<template>
  <section v-if="checklist.data.value && !checklist.data.value.done" aria-labelledby="factory-setup-title" class="rounded-lg border border-default p-5">
    <div class="flex items-baseline justify-between gap-4">
      <h2 id="factory-setup-title" class="font-medium text-highlighted">Set up Factory</h2>
      <span class="shrink-0 text-xs tabular-nums text-muted">{{ steps.length - remaining }} of {{ steps.length }} done</span>
    </div>
    <p class="mt-1 text-sm text-muted">From a fresh Server to an agent's pull request. Each step opens where it is done and ticks itself off.</p>
    <ol class="mt-4 divide-y divide-default">
      <li v-for="step in steps" :key="step.key" class="flex items-center gap-3 py-3" :data-step="step.key">
        <UIcon :name="checklist.data.value.steps[step.key] ? 'i-ph-check-circle' : 'i-ph-circle'" class="size-5 shrink-0" :class="checklist.data.value.steps[step.key] ? 'text-primary' : 'text-dimmed'" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium" :class="checklist.data.value.steps[step.key] ? 'text-muted line-through' : 'text-highlighted'">{{ step.title }}</p>
          <p v-if="!checklist.data.value.steps[step.key]" class="mt-0.5 text-xs text-muted">{{ step.description }}</p>
        </div>
        <UButton v-if="!checklist.data.value.steps[step.key] && (step.key === next || !['repository', 'access', 'run'].includes(step.key))" :label="step.action" size="sm" :color="step.key === next ? 'primary' : 'neutral'" :variant="step.key === next ? 'solid' : 'outline'" @click="step.go()" />
      </li>
    </ol>
  </section>
</template>
