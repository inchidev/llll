<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useClipboard } from '@vueuse/core'
import { MCP_SCOPES, type CreatedMcpAccessTokenDTO, type McpAccessTokenDTO, type McpScope } from '~~/shared/mcp'
import type { MemberDTO } from '~~/shared/types'
import { formatDateTime } from '~~/shared/format'

const props = defineProps<{ workspaceId: string }>()
const { api, serverUrl } = useApi()
const toast = useToast()
const queryClient = useQueryClient()
const { copy } = useClipboard()
const name = ref('Codex')
const subjectId = ref<string>()
const scopes = ref<McpScope[]>([...MCP_SCOPES])
const created = shallowRef<CreatedMcpAccessTokenDTO | null>(null)
const revokeTarget = shallowRef<McpAccessTokenDTO | null>(null)

const tokensQ = useQuery({
  queryKey: computed(() => ['mcp-tokens', props.workspaceId]),
  queryFn: () => api<{ tokens: McpAccessTokenDTO[] }>(`/api/workspaces/${props.workspaceId}/mcp-tokens`),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.workspaceId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/workspaces/${props.workspaceId}/members`),
})
const subjectOptions = computed(() => (membersQ.data.value?.members ?? []).map(member => ({
  label: `${member.user.displayName} · ${member.user.kind === 'agent' ? 'Agent' : member.role.name}`,
  value: member.user.id,
})))
watch(subjectOptions, (options) => { if (!subjectId.value && options[0]) subjectId.value = options[0].value }, { immediate: true })

const scopeOptions: Array<{ value: McpScope; label: string }> = [
  { value: 'tasks:read', label: 'Read tasks' },
  { value: 'tasks:write', label: 'Write tasks' },
  { value: 'documents:read', label: 'Read documents' },
  { value: 'documents:write', label: 'Write documents' },
]

const createToken = useMutation({
  mutationFn: (input: { name: string; subjectId: string; scopes: McpScope[] }) => api<{ token: CreatedMcpAccessTokenDTO }>(`/api/workspaces/${props.workspaceId}/mcp-tokens`, {
    method: 'POST',
    body: input,
  }),
  onSuccess: async ({ token }) => {
    created.value = token
    await queryClient.invalidateQueries({ queryKey: ['mcp-tokens', props.workspaceId] })
    toast.add({ title: 'Access token created', color: 'success' })
  },
  onError: error => toast.add({ title: errorMessage(error), color: 'error' }),
})

const revokeToken = useMutation({
  mutationFn: (tokenId: string) => api(`/api/workspaces/${props.workspaceId}/mcp-tokens/${tokenId}`, { method: 'DELETE' }),
  onSuccess: async () => {
    const revokedId = revokeTarget.value?.id
    revokeTarget.value = null
    if (created.value?.id === revokedId) created.value = null
    await queryClient.invalidateQueries({ queryKey: ['mcp-tokens', props.workspaceId] })
    toast.add({ title: 'Access token revoked', color: 'success' })
  },
  onError: error => toast.add({ title: errorMessage(error), color: 'error' }),
})

function create() {
  const tokenName = name.value.trim()
  if (!tokenName || !subjectId.value || !scopes.value.length || createToken.isPending.value) return
  created.value = null
  createToken.mutate({ name: tokenName, subjectId: subjectId.value, scopes: scopes.value })
}

async function copyValue(value: string, label: string) {
  await copy(value)
  toast.add({ title: `${label} copied`, color: 'success' })
}
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">MCP</h1>
    <p class="mt-1 text-sm text-muted">Connect Codex and other MCP clients to this workspace.</p>

    <div class="mt-8 rounded-lg border border-default bg-elevated p-5">
      <UFormField label="Server URL">
        <div class="flex gap-2">
          <UInput :model-value="serverUrl('/mcp')" readonly class="min-w-0 flex-1 font-mono" />
          <UButton color="neutral" variant="soft" label="Copy" @click="copyValue(serverUrl('/mcp'), 'Server URL')" />
        </div>
      </UFormField>

      <div class="mt-5 grid gap-4 sm:grid-cols-2">
        <UFormField label="Token name">
          <UInput v-model="name" class="w-full" maxlength="80" autocomplete="off" @keyup.enter="create" />
        </UFormField>
        <UFormField label="Acts as">
          <USelect v-model="subjectId" :items="subjectOptions" class="w-full" />
        </UFormField>
      </div>
      <UFormField label="Scopes" class="mt-4">
        <div class="grid gap-2 sm:grid-cols-2">
          <UCheckbox
            v-for="scope in scopeOptions"
            :key="scope.value"
            :model-value="scopes.includes(scope.value)"
            :label="scope.label"
            @update:model-value="(checked: boolean | 'indeterminate') => { scopes = checked === true ? [...new Set([...scopes, scope.value])] : scopes.filter(value => value !== scope.value) }"
          />
        </div>
      </UFormField>
      <div class="mt-4 flex justify-end">
        <UButton label="Create access token" :loading="createToken.isPending.value" :disabled="!name.trim() || !subjectId || !scopes.length" @click="create" />
      </div>

      <UAlert
        v-if="created"
        class="mt-5"
        color="warning"
        variant="subtle"
        title="Copy this token now"
        description="It will not be shown again. Treat it like a password."
      >
        <template #actions>
          <div class="mt-2 flex w-full min-w-0 gap-2">
            <UInput :model-value="created.token" readonly class="min-w-0 flex-1 font-mono" />
            <UButton color="warning" variant="soft" label="Copy token" @click="copyValue(created.token, 'Access token')" />
          </div>
        </template>
      </UAlert>
    </div>

    <LayoutSkeleton v-if="tokensQ.isPending.value" variant="cards" :rows="2" class="mt-5" />
    <LayoutLoadError v-else-if="tokensQ.error.value" message="Access tokens did not load." :retry="tokensQ.refetch" />
    <div v-else class="mt-5 rounded-lg border border-default">
      <div class="border-b border-default px-5 py-4">
        <p class="font-medium text-highlighted">Access tokens</p>
      </div>
      <div v-if="!tokensQ.data.value?.tokens.length" class="px-5 py-8 text-sm text-muted">No access tokens.</div>
      <ul v-else class="divide-y divide-default">
        <li v-for="token in tokensQ.data.value.tokens" :key="token.id" class="flex items-center gap-4 px-5 py-4">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-highlighted">{{ token.name }}</p>
            <p class="mt-1 text-xs text-muted">Acts as {{ token.subject.displayName }} · {{ token.scopes.join(', ') }}</p>
            <p class="mt-1 text-xs text-muted">
              <span class="font-mono">{{ token.tokenPrefix }}…</span>
              · Created {{ formatDateTime(token.createdAt) }}
              · {{ token.lastUsedAt ? `Last used ${formatDateTime(token.lastUsedAt)}` : 'Never used' }}
            </p>
          </div>
          <UButton color="error" variant="ghost" size="sm" label="Revoke" @click="revokeTarget = token" />
        </li>
      </ul>
    </div>

    <UModal :open="Boolean(revokeTarget)" title="Revoke this access token?" @update:open="(value: boolean) => { if (!value) revokeTarget = null }">
      <template #body>
        <p class="text-sm text-muted">Clients using {{ revokeTarget?.name }} will lose access immediately.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" @click="revokeTarget = null" />
        <UButton color="error" label="Revoke" :loading="revokeToken.isPending.value" @click="revokeTarget && revokeToken.mutate(revokeTarget.id)" />
      </template>
    </UModal>
  </div>
</template>
