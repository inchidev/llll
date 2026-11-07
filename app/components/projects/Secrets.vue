<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ProjectSecret } from '~~/shared/project-factory'
import { dropFromList, putInList } from '~/utils/list-cache'
const props = defineProps<{ projectId: string; archived: boolean }>()
const { api } = useApi(), toast = useToast(), cache = useQueryClient()
const key = computed(() => ['project-secrets', props.projectId])
const query = useQuery({ queryKey: key, queryFn: () => api<{ secrets: ProjectSecret[]; canManage: boolean }>(`/api/projects/${props.projectId}/secrets`) })
const editable = computed(() => Boolean(query.data.value?.canManage) && !props.archived)
const open = ref(false), busy = ref(false), editing = ref<ProjectSecret | null>(null), name = ref(''), value = ref(''), hosts = ref('')
const hostList = computed(() => [...new Set(hosts.value.split(/[\s,]+/u).map(host => host.trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '')).filter(Boolean))])
function edit(secret: ProjectSecret | null) { editing.value = secret; name.value = secret?.name ?? ''; value.value = ''; hosts.value = secret?.hosts.join(', ') ?? ''; open.value = true }
async function save() {
  busy.value = true
  try {
    const saved = editing.value
      ? await api<{ secret: ProjectSecret }>(`/api/projects/${props.projectId}/secrets/${editing.value.id}`, { method: 'PUT', body: { hosts: hostList.value, ...(value.value ? { value: value.value } : {}) } })
      : await api<{ secret: ProjectSecret }>(`/api/projects/${props.projectId}/secrets`, { method: 'PUT', body: { name: name.value, value: value.value, hosts: hostList.value } })
    putInList(cache, key.value, 'secrets', saved.secret)
    value.value = ''; open.value = false; await query.refetch()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
async function remove() {
  if (!editing.value) return
  busy.value = true
  try { await api(`/api/projects/${props.projectId}/secrets/${editing.value.id}`, { method: 'DELETE' }); dropFromList(cache, key.value, 'secrets', editing.value.id); open.value = false; await query.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
const date = (value: string) => new Date(value).toLocaleString()
</script>
<template>
  <section class="space-y-4" aria-labelledby="project-secrets">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h3 id="project-secrets" class="font-medium">Secrets</h3><p class="mt-1 text-sm text-muted">Tokens and keys this project’s Agents may use. You enter a value once and nobody reads it back, Agents included: an Agent sends the placeholder, and its box’s egress puts the value in only on requests to the hosts you bind it to. Don’t paste tokens into a conversation; add them here.</p></div>
      <UButton v-if="editable" label="Add secret" icon="i-ph-plus" color="neutral" variant="outline" @click="edit(null)" />
    </div>
    <LayoutLoadError v-if="query.error.value" message="Secrets did not load." :retry="query.refetch" />
    <div v-else-if="query.data.value?.secrets.length" class="divide-y divide-default rounded-lg border border-default">
      <div v-for="secret in query.data.value.secrets" :key="secret.id" class="flex flex-wrap items-center justify-between gap-3 p-4">
        <div class="min-w-0"><p class="break-all font-mono text-sm font-medium">{{ secret.placeholder }}</p><p class="break-all text-xs text-muted">Bound to {{ secret.hosts.join(', ') }}</p><p class="text-xs text-muted">Changed {{ date(secret.updatedAt) }}<template v-if="secret.lastUsedAt"> · last used {{ date(secret.lastUsedAt) }}</template></p></div>
        <UButton v-if="editable" label="Replace" color="neutral" variant="ghost" @click="edit(secret)" />
      </div>
    </div>
    <p v-else-if="!query.isPending.value" class="text-sm text-muted">No secrets.</p>
    <UModal v-model:open="open" :title="editing ? `Replace ${editing.placeholder}` : 'Add secret'" description="The value is encrypted on this Server and never shown again.">
      <template #body><form class="space-y-5" autocomplete="off" @submit.prevent="save">
        <UFormField v-if="!editing" label="Name" help="Letters, digits and underscores. The Agent sees L4_SECRET_ and this name."><UInput v-model="name" placeholder="TELEGRAM_TOKEN" class="w-full" /></UFormField>
        <UFormField label="Value" :help="editing ? 'Leave empty to keep the current value and change only its hosts.' : undefined"><UInput v-model="value" type="password" autocomplete="new-password" class="w-full" /></UFormField>
        <UFormField label="Bound hosts" help="The only hosts this value may go to, separated by commas, such as api.telegram.org. A host must also be open: in the project’s network, or through a window."><UInput v-model="hosts" placeholder="api.telegram.org" class="w-full" /></UFormField>
        <div class="flex flex-wrap justify-between gap-2"><UButton v-if="editing" label="Delete secret" color="error" variant="ghost" :loading="busy" @click="remove" /><span v-else /><div class="flex gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" :label="editing ? 'Save' : 'Add secret'" :loading="busy" :disabled="!hostList.length || (!editing && (!name || !value))" /></div></div>
      </form></template>
    </UModal>
  </section>
</template>
