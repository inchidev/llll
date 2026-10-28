<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useClipboard } from '@vueuse/core'
import { pausedMcpScopes } from '~~/shared/features'
import { MCP_DEFAULT_TOKEN_SCOPES, type CreatedMcpAccessTokenDTO, type McpAccessTokenDTO, type McpScope } from '~~/shared/mcp'
import type { MemberDTO } from '~~/shared/types'
import { formatDateTime } from '~~/shared/format'

const props = defineProps<{ serverId: string }>()
const { api, serverUrl } = useApi()
const session = useSessionStore()
const toast = useToast()
const queryClient = useQueryClient()
const { copy } = useClipboard()
const name = ref('Codex')
const subjectId = ref<string>()
const scopes = ref<McpScope[]>(MCP_DEFAULT_TOKEN_SCOPES.filter(scope => !pausedMcpScopes.has(scope)))
const created = shallowRef<CreatedMcpAccessTokenDTO | null>(null)
const revokeTarget = shallowRef<McpAccessTokenDTO | null>(null)

const tokensQ = useQuery({
  queryKey: computed(() => ['mcp-tokens', props.serverId]),
  queryFn: () => api<{ tokens: McpAccessTokenDTO[] }>(`/api/servers/${props.serverId}/mcp-tokens`),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${props.serverId}/members`),
})
const subjectOptions = computed(() => (membersQ.data.value?.members ?? []).filter(member => member.user.id === session.user?.id || member.user.kind === 'agent').map(member => ({
  label: `${member.user.displayName} · ${member.user.kind === 'agent' ? 'Agent' : member.role.name}`,
  value: member.user.id,
})))
watch(subjectOptions, (options) => { if (!subjectId.value && options[0]) subjectId.value = options.find(option => option.value === session.user?.id)?.value ?? options[0].value }, { immediate: true })

const scopeOptions: Array<{ value: McpScope; label: string }> = [
  { value: 'tasks:read', label: 'Read tasks' },
  { value: 'tasks:write', label: 'Write tasks' },
  { value: 'messages:read', label: 'Read accessible chats and messages' },
  { value: 'messages:write', label: 'Send messages and mentions' },
  { value: 'mail:read', label: 'Read and search shared Mailboxes' },
  { value: 'mail:write', label: 'Mark email read and move conversations' },
]

const createToken = useMutation({
  mutationFn: (input: { name: string; subjectId: string; scopes: McpScope[] }) => api<{ token: CreatedMcpAccessTokenDTO }>(`/api/servers/${props.serverId}/mcp-tokens`, {
    method: 'POST',
    body: input,
  }),
  onSuccess: async ({ token }) => {
    created.value = token
    await queryClient.invalidateQueries({ queryKey: ['mcp-tokens', props.serverId] })
    toast.add({ title: 'Access token created', color: 'success' })
  },
  onError: error => toast.add({ title: errorMessage(error), color: 'error' }),
})

const revokeToken = useMutation({
  mutationFn: (tokenId: string) => api(`/api/servers/${props.serverId}/mcp-tokens/${tokenId}`, { method: 'DELETE' }),
  onSuccess: async () => {
    const revokedId = revokeTarget.value?.id
    revokeTarget.value = null
    if (created.value?.id === revokedId) created.value = null
    await queryClient.invalidateQueries({ queryKey: ['mcp-tokens', props.serverId] })
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
    <h1 class="text-xl font-semibold text-highlighted">Access tokens</h1>
    <p class="mt-1 text-sm text-muted">Server access tokens managed by the owner. Each token acts as you or a selected Agent, within its current Role and selected scopes.</p>
    <UAlert
      class="mt-6" color="neutral" variant="subtle" title="For clients without OAuth"
      description="Use a manual token only when your client needs one. OAuth connections are managed separately in My Settings → Connected apps." />

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
            <p class="mt-1 text-xs text-muted">Acts as {{ token.subject.displayName }} · Created by {{ token.createdBy.displayName }}</p>
            <p class="mt-1 text-xs text-muted">{{ token.scopes.join(', ') }}</p>
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
