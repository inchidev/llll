<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery } from '@tanstack/vue-query'
import type { GitConnection } from '~~/shared/git-connections'
import type { CodeEnvironment, CodeEnvironmentInput } from '~~/shared/code-environments'

defineProps<{ serverId: string }>()
const providerTab = ref('github')
const gitConnections = ref<{ connect: () => void; refresh: () => Promise<void> } | null>(null)
const refreshing = ref(false)
async function refreshConnections() {
  refreshing.value = true
  // A fast refresh still shows the spinner long enough to register as a response.
  try { await Promise.all([gitConnections.value?.refresh(), new Promise(resolve => setTimeout(resolve, 500))]) }
  finally { refreshing.value = false }
}
const { api } = useApi()
const toast = useToast()
const nodes = useQuery({ queryKey: ['compute-nodes'], queryFn: () => api<{ nodes: { id: string; name: string; enabled: boolean; capabilities?: { provider?: string } }[] }>('/api/compute-nodes') })
const computeNodeId = ref<string | null>(null)
const list = useQuery({ queryKey: ['code-environments'], queryFn: () => api<{ configured: boolean; deploymentConfigured: boolean; environments: CodeEnvironment[] }>('/api/code-environments') })
type Repository = { id: number; name: string; installationId: number; fork: boolean; defaultBranch: string }
const connections = useQuery({ queryKey: ['git-connections'], queryFn: () => api<{ connections: GitConnection[]; canConfigure: boolean }>('/api/git-connections') })
const connectionId = ref<string | null>(null)
const connectionOptions = computed(() => [...(list.data.value?.deploymentConfigured ? [{ label: 'Deployment-configured App', value: null }] : []), ...(connections.data.value?.connections ?? []).filter(c => c.enabled).map(c => ({ label: c.name, value: c.id }))])
const repositories = useQuery({ queryKey: computed(() => ['agent-repositories', connectionId.value]), queryFn: () => api<{ configured: boolean; repositories: Repository[] }>('/api/code-environments/repositories', { query: { connectionId: connectionId.value || undefined } }) })
watch(connectionId, () => { sourceId.value = undefined; workId.value = undefined }, { flush: 'sync' })
const options = computed(() => (repositories.data.value?.repositories ?? []).map(repo => ({ label: repo.name, value: repo.id })))
const sourceId = ref<number>()
const workId = ref<number>()
watch(sourceId, id => { if (!workId.value) workId.value = id })
const name = ref('')
const baseBranch = ref('main')
const requiredChecks = ref('')
const previewHosts = ref('')
const editingId = ref<string>()
const selectedEnvironment = computed(() => list.data.value?.environments.find(item => item.id === editingId.value))
const open = ref(false)
const saving = ref(false)
function edit(item?: CodeEnvironment) {
  computeNodeId.value = item ? item.computeNodeId ?? null : ((nodes.data.value?.nodes.find(node => node.enabled && ['Local VPS executor', 'Cloudflare Factory'].includes(node.name)) ?? nodes.data.value?.nodes.find(node => node.enabled))?.id ?? null)
  connectionId.value = item ? item.gitConnectionId ?? null : connectionId.value; editingId.value = item?.id; name.value = item?.name ?? ''; sourceId.value = item?.sourceRepoId; workId.value = item?.workRepoId
  baseBranch.value = item?.baseBranch ?? 'main'; requiredChecks.value = item?.requiredChecks.join('\n') ?? ''; previewHosts.value = item?.previewHosts.join('\n') ?? ''; open.value = true
}
async function save() {
  const source = repositories.data.value?.repositories.find(repo => repo.id === sourceId.value)
  const work = repositories.data.value?.repositories.find(repo => repo.id === workId.value)
  if (!source || !work) return
  const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)
  const body: CodeEnvironmentInput = { computeNodeId: computeNodeId.value, gitConnectionId: connectionId.value, name: name.value, sourceRepo: source.name, sourceRepoId: source.id, sourceInstallationId: source.installationId,
    workRepo: work.name, workRepoId: work.id, workInstallationId: work.installationId, baseBranch: baseBranch.value,
    requiredChecks: lines(requiredChecks.value), previewHosts: lines(previewHosts.value) }
  saving.value = true
  try { await api(editingId.value ? `/api/code-environments/${editingId.value}` : '/api/code-environments', { method: editingId.value ? 'PATCH' : 'POST', body }); open.value = false; await list.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}
async function disable(item: CodeEnvironment) {
  saving.value = true
  try { await api(`/api/code-environments/${item.id}`, { method: 'DELETE' }); open.value = false; await list.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <SettingsHeader title="Git"><template #actions><UButton v-if="providerTab === 'github'" icon="i-ph-arrows-clockwise" aria-label="Refresh Git connections" color="neutral" variant="ghost" :loading="refreshing" @click="refreshConnections" /><UButton v-if="providerTab === 'github' && connections.data.value?.canConfigure" label="Connect GitHub" icon="i-ph-plus" @click="gitConnections?.connect()" /><UButton v-else-if="providerTab === 'environments' && list.data.value?.configured" label="Add environment" icon="i-ph-plus" @click="edit()" /></template></SettingsHeader>
    <LayoutSegmentedTabs v-model="providerTab" :items="[{ label: 'GitHub', value: 'github' }, { label: 'GitLab', value: 'gitlab' }, { label: 'Gitea', value: 'gitea' }, { label: 'Environments', value: 'environments' }]" label="Git providers" />
    <SettingsGitConnections v-if="providerTab === 'github'" ref="gitConnections" />
    <p v-else-if="providerTab === 'gitlab' || providerTab === 'gitea'" class="text-sm text-muted">{{ providerTab === 'gitlab' ? 'GitLab' : 'Gitea' }} connections are not available yet.</p>
    <template v-else>
      <LayoutLoadError v-if="list.error.value || repositories.error.value" message="Repository configuration did not load." :retry="() => { list.refetch(); repositories.refetch() }" />
      <UAlert v-if="list.data.value && !list.data.value.configured" title="Connect a GitHub App" description="Connect GitHub and authorize repositories before adding an environment." color="neutral" variant="subtle" />
      <SettingsList :items="list.data.value?.environments ?? []" :item-key="item => item.id" :search-text="item => `${item.name} ${item.sourceRepo}`" placeholder="Search environments" :noun="['environment', 'environments']" @select="edit">
        <template #row="{ item }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon name="i-ph-git-branch" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block font-medium">{{ item.name }} <UBadge v-if="!item.enabled" label="Disabled" color="neutral" variant="subtle" /></span><span class="block truncate text-xs text-muted">{{ item.sourceRepo }} · {{ item.baseBranch }}</span></span></template>
      </SettingsList>
    </template>
    <SettingsEditor v-model:open="open" back="Git" :title="editingId ? 'Edit environment' : 'Add environment'" description="Saving changes revokes Runs and scheduled mandates using the previous configuration.">
      <template #body><div class="space-y-4">
        <UFormField label="Name" help="A short label for this repository and execution setup, for example Website fixes."><UInput v-model="name" class="w-full" /></UFormField>
        <UFormField label="Git connection"><USelect v-model="connectionId" :items="connectionOptions" placeholder="Choose a Git connection" class="w-full" /></UFormField>
        <UButton label="Refresh repositories" color="neutral" variant="outline" @click="repositories.refetch()" />
        <p v-if="repositories.data.value && !repositories.data.value.repositories.length" class="text-sm text-muted">Choose a Git connection. If no repositories appear, authorize them on GitHub and refresh the list.</p>
        <UFormField label="Source repository"><USelect v-model="sourceId" :items="options" placeholder="Choose source" class="w-full" /></UFormField>
        <UFormField label="Working repository" help="Choose the source repository for ordinary branch-based work, or an optional fork. Changes use a dedicated working branch."><USelect v-model="workId" :items="options" placeholder="Choose repository" class="w-full" /></UFormField>
        <UFormField label="Compute Node" help="Choose where this repository's task runs execute."><USelect v-model="computeNodeId" :items="[{ label: 'No compute backend', value: null }, ...(nodes.data.value?.nodes ?? []).filter(node => node.enabled).map(node => ({ label: node.capabilities?.provider === 'lizard' ? 'Lizard' : node.name, value: node.id }))]" class="w-full" /></UFormField>
        <UFormField label="Base branch"><UInput v-model="baseBranch" class="w-full" /></UFormField>
        <UFormField label="Required CI checks" help="One exact check or commit-status name per line. Missing checks keep the proposal unverified."><UTextarea v-model="requiredChecks" class="w-full" :rows="3" /></UFormField>
        <UFormField label="Allowed Preview domains" help="One domain per line, for example dev.example.com. Preview links must use HTTPS."><UTextarea v-model="previewHosts" class="w-full" :rows="2" /></UFormField>
      </div></template>
      <template #footer><div class="flex w-full justify-between gap-2"><UButton v-if="selectedEnvironment?.enabled" label="Disable" color="error" variant="ghost" :loading="saving" @click="disable(selectedEnvironment)" /><span v-else /><UButton label="Save environment" color="neutral" :loading="saving" :disabled="!name.trim() || !sourceId || !workId || !requiredChecks.trim()" @click="save" /></div></template>
    </SettingsEditor>
  </div>
</template>
