<script setup lang="ts">
import { MCP_SCOPE_LABELS, type McpConsentDTO, type McpScope } from '~~/shared/mcp'

definePageMeta({ layout: 'auth', middleware: ['auth'] })
useHead({ title: 'Connect an MCP client', meta: [{ name: 'referrer', content: 'no-referrer' }] })

const route = useRoute()
const session = useSessionStore()
const { api } = useApi()
const consent = shallowRef<McpConsentDTO | null>(null)
const error = ref('')
const subjectId = ref(session.user?.id || '')
const scopes = ref<McpScope[]>([])
const busy = ref(false)
const loading = ref(true)
const oauthQuery = computed(() => route.fullPath.split('?').slice(1).join('?').split('#')[0] || '')
const subject = computed(() => consent.value?.subjects.find(item => item.id === subjectId.value))
const allowedScopes = computed(() => consent.value?.scopes.filter(scope => subject.value?.scopes.includes(scope)) || [])
const subjectOptions = computed(() => consent.value?.subjects.map(item => ({
  value: item.id,
  label: item.kind === 'agent' ? `${item.displayName} · Agent` : `${item.displayName} · You`,
})) || [])

watch(allowedScopes, value => { scopes.value = [...value] })

onMounted(async () => {
  try {
    consent.value = await api<McpConsentDTO>('/api/mcp/consent', { query: { oauth_query: oauthQuery.value } })
    subjectId.value = session.user?.id || ''
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
})

async function decide(accept: boolean) {
  busy.value = true
  error.value = ''
  try {
    const result = await api<{ url: string }>('/api/mcp/consent', {
      method: 'POST', body: { oauth_query: oauthQuery.value, accept, subjectId: subjectId.value, scopes: scopes.value },
    })
    // This callback has been validated by the OAuth provider, including native-client URLs.
    window.location.assign(result.url)
  }
  catch (cause) { error.value = errorMessage(cause); busy.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <UIcon name="i-ph-plugs-connected" class="mb-4 size-8 text-muted" />
      <h1 class="text-2xl font-semibold text-highlighted">Connect {{ consent?.clientName || 'an MCP client' }}</h1>
      <p class="mt-2 text-sm text-muted">Grant access to this Server as yourself or an Agent you manage.</p>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" title="Connection could not be completed" :description="error" />
    <p v-if="loading" role="status" class="text-sm text-muted">Loading connection request…</p>
    <template v-else-if="consent">
      <div class="rounded-lg border border-default p-4 text-sm">
        <p class="font-medium text-highlighted">{{ consent.clientName }}</p>
        <p class="mt-1 text-muted">Client names are supplied by the application. Check the callback before allowing access.</p>
        <p class="mt-3 break-all font-mono text-xs text-muted">{{ consent.redirectUri }}</p>
      </div>

      <UFormField label="Act as" description="Actions and authorship belong to this Member. Their current Role still applies.">
        <USelect v-model="subjectId" :items="subjectOptions" class="w-full" :disabled="busy" />
      </UFormField>

      <fieldset>
        <legend class="mb-3 text-sm font-medium text-highlighted">Allow this application to</legend>
        <div class="space-y-3">
          <UCheckbox
            v-for="scope in consent.scopes" :key="scope" :label="MCP_SCOPE_LABELS[scope]"
            :disabled="busy || !allowedScopes.includes(scope)" :model-value="scopes.includes(scope)"
            @update:model-value="checked => { scopes = checked === true ? [...new Set([...scopes, scope])] : scopes.filter(value => value !== scope) }" />
        </div>
      </fieldset>
      <p v-if="!allowedScopes.length" class="text-sm text-muted">This Member’s Role does not allow the requested actions.</p>
      <p v-if="consent.offlineAccess" class="text-sm text-muted">The application may renew access until this connection is revoked or expires.</p>
      <p class="text-sm text-muted">You can revoke access in My Settings → Connected apps on this Server.</p>

      <div class="flex flex-wrap justify-end gap-3">
        <UButton label="Deny" color="neutral" variant="soft" :disabled="busy" @click="decide(false)" />
        <UButton label="Allow access" :loading="busy" :disabled="!subjectId || !scopes.length" @click="decide(true)" />
      </div>
    </template>
  </div>
</template>
