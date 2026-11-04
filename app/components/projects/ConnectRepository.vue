<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
const props = defineProps<{ projectId: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ connected: [] }>()
const { api } = useApi(), toast = useToast(), nav = useNavActions()
type Options = { connections: { id: string; provider: 'github' | 'gitea'; name: string; host: string; account: string }[]; deploymentGithub: boolean; compute: { id: string; name: string; provider: string | null }[]; agents: number; canConfigureCredentials: boolean }
type Repository = { id: number; name: string; defaultBranch: string }
// The deployment-configured GitHub App has no connection row; it is the empty choice.
const DEPLOYMENT = 'deployment'
const connectionId = ref(''), repositoryId = ref<number | undefined>(), baseBranch = ref(''), checks = ref<string[]>([]), computeNodeId = ref(''), previewHosts = ref('')
const busy = ref(false), connected = ref<string | null>(null)
const options = useQuery({ queryKey: computed(() => ['connect-repository', props.projectId]), queryFn: () => api<Options>(`/api/projects/${props.projectId}/connect-repository`), enabled: open })
const connectionItems = computed(() => [
  ...(options.data.value?.deploymentGithub ? [{ value: DEPLOYMENT, label: 'GitHub (this Server’s app)' }] : []),
  ...(options.data.value?.connections ?? []).map(c => ({ value: c.id, label: c.provider === 'gitea' ? `${c.account} on ${new URL(c.host).host}` : c.name })),
])
const noGit = computed(() => options.isSuccess.value && !connectionItems.value.length)
const connection = computed(() => connectionId.value === DEPLOYMENT ? undefined : connectionId.value || undefined)
const repositories = useQuery({
  queryKey: computed(() => ['agent-repositories', connection.value ?? null]),
  queryFn: () => api<{ repositories: Repository[] }>('/api/code-environments/repositories', { query: { connectionId: connection.value } }),
  enabled: computed(() => open.value && Boolean(connectionId.value)),
})
const inspected = useQuery({
  queryKey: computed(() => ['connect-repository-inspect', props.projectId, connection.value ?? null, repositoryId.value]),
  queryFn: () => api<{ defaultBranch: string; checks: string[]; previewHosts?: string[] }>(`/api/projects/${props.projectId}/connect-repository/inspect`, { query: { connectionId: connection.value, repositoryId: repositoryId.value } }),
  enabled: computed(() => open.value && repositoryId.value !== undefined),
})
const compute = computed(() => options.data.value?.compute ?? [])
watch(() => options.data.value, data => { if (data && !connectionId.value && connectionItems.value.length === 1) connectionId.value = connectionItems.value[0]!.value })
watch(connectionId, () => { repositoryId.value = undefined })
watch(() => inspected.data.value, data => { baseBranch.value = data?.defaultBranch ?? ''; checks.value = []; previewHosts.value = (data?.previewHosts ?? []).join(', ') })
watch(open, value => { if (value) { connected.value = null; repositoryId.value = undefined; computeNodeId.value = '' } })

function openSettings(section: string) { open.value = false; nav.openServerSettings(section) }
async function connect() {
  busy.value = true
  try {
    const result = await api<{ repository: { slug: string } }>(`/api/projects/${props.projectId}/connect-repository`, { method: 'POST', body: {
      gitConnectionId: connection.value ?? null, repositoryId: repositoryId.value, baseBranch: baseBranch.value.trim() || undefined,
      requiredChecks: checks.value, computeNodeId: computeNodeId.value || null,
      previewHosts: previewHosts.value.split(/[\s,]+/u).map(host => host.trim().toLowerCase()).filter(Boolean),
    } })
    connected.value = result.repository.slug
    emit('connected')
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <UModal v-model:open="open" title="Connect a repository" description="Agents assigned to this project's tasks can then work on it and open pull requests for review.">
    <template #body>
      <LayoutLoadError v-if="options.error.value" message="Repository setup did not load." :retry="options.refetch" />
      <div v-else-if="connected" class="space-y-4">
        <UAlert color="success" variant="subtle" icon="i-ph-check-circle" :title="`${connected} is connected`" :description="compute.length ? 'Assign a task in this project to an agent to start work.' : 'Agents can read it now. Add a computer so they can run and test code.'" />
        <div class="flex flex-wrap justify-end gap-2">
          <UButton v-if="!compute.length && options.data.value?.canConfigureCredentials" label="Add a computer" color="neutral" variant="outline" @click="openSettings('compute')" />
          <UButton v-if="!options.data.value?.agents" label="Create an agent" color="neutral" variant="outline" @click="open = false; nav.createAgentOpen.value = true" />
          <UButton label="Done" @click="open = false" />
        </div>
      </div>
      <form v-else class="space-y-5" @submit.prevent="connect">
        <LayoutSkeleton v-if="options.isPending.value" variant="rows" :rows="2" />
        <template v-else-if="noGit">
          <UAlert color="neutral" variant="subtle" title="Connect GitHub or Gitea first" description="Agents reach repositories through a dedicated GitHub App or a Gitea bot account. It is set up once for the whole Server." />
          <div class="flex justify-end"><UButton v-if="options.data.value?.canConfigureCredentials" label="Open Git settings" @click="openSettings('environments')" /><p v-else class="text-sm text-muted">Ask the Server Owner to connect it.</p></div>
        </template>
        <template v-else>
          <UFormField v-if="connectionItems.length > 1" label="Git connection"><USelect v-model="connectionId" :items="connectionItems" placeholder="Choose" class="w-full" /></UFormField>
          <UFormField label="Repository" :description="repositories.data.value && !repositories.data.value.repositories.length ? 'No repositories yet. Give the connection access to one, then refresh.' : undefined">
            <div class="flex gap-2">
              <USelectMenu v-model="repositoryId" :items="(repositories.data.value?.repositories ?? []).map(r => ({ value: r.id, label: r.name }))" value-key="value" :loading="repositories.isFetching.value" :disabled="!connectionId" placeholder="Choose a repository" class="min-w-0 flex-1" />
              <UButton icon="i-ph-arrows-clockwise" color="neutral" variant="outline" aria-label="Refresh repositories" :disabled="!connectionId" :loading="repositories.isFetching.value" @click="repositories.refetch()" />
            </div>
          </UFormField>
          <template v-if="repositoryId !== undefined">
            <LayoutSkeleton v-if="inspected.isPending.value" variant="rows" :rows="2" />
            <LayoutLoadError v-else-if="inspected.error.value" inline message="The repository could not be read." :retry="inspected.refetch" />
            <template v-else>
              <UFormField label="Base branch" description="Agents start from it and open pull requests against it."><UInput v-model="baseBranch" class="w-full" /></UFormField>
              <UFormField label="Checks that must pass" :description="inspected.data.value?.checks.length ? 'Found on the latest commit. With none selected, every check CI reports must pass.' : 'No CI checks found on the latest commit. Pull requests stay unverified until CI reports one.'">
                <UCheckboxGroup v-if="inspected.data.value?.checks.length" v-model="checks" :items="inspected.data.value.checks" />
              </UFormField>
              <UFormField label="Preview domains" :description="inspected.data.value?.previewHosts?.length ? 'Found in the latest commit\'s deployment links. Agents report preview links on these domains for review.' : 'Where pull request previews are deployed, such as vercel.app. Agents report preview links on these domains for review. Leave empty if there are none.'">
                <UInput v-model="previewHosts" placeholder="vercel.app" class="w-full" />
              </UFormField>
              <UFormField label="Computer" :description="compute.length ? 'Where agents edit, build and test the code.' : 'None yet. Agents can read the repository but cannot run code until one is added.'">
                <USelect v-if="compute.length > 1" v-model="computeNodeId" :items="compute.map(c => ({ value: c.id, label: c.name }))" placeholder="Choose a computer" class="w-full" />
                <p v-else-if="compute.length" class="text-sm">{{ compute[0]!.name }}</p>
              </UFormField>
            </template>
          </template>
          <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Connect" :loading="busy" :disabled="repositoryId === undefined || !inspected.isSuccess.value || !baseBranch.trim() || (compute.length > 1 && !computeNodeId)" /></div>
        </template>
      </form>
    </template>
  </UModal>
</template>
