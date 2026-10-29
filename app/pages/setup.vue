<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

definePageMeta({ layout: 'auth' })

const session = useSessionStore()
const { api } = useApi()
const health = computed(() => session.health)
const busy = ref(false)
const signedIn = ref(false)
const error = ref<string | null>(null)
const claimToken = useState('owner-claim', () => '')
const ownerEmail = ref('')
const pastedToken = ref('')

const schema = z.object({
  serverName: z.string().trim().min(1, 'Name the Server').max(80),
  name: z.string().trim().min(1, 'Name is required').max(80),
  password: z.string().min(12, 'Use at least 12 characters'),
  confirm: z.string().min(12),
}).superRefine((value, context) => {
  if (value.password !== value.confirm) context.addIssue({ code: 'custom', path: ['confirm'], message: 'Passwords do not match' })
})
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ serverName: 'L4', name: '', password: '', confirm: '' })

const missing = computed(() => {
  const bindings = health.value?.bindings
  const out: string[] = []
  if (bindings && !bindings.db) out.push('database')
  if (bindings && !bindings.kv) out.push('tickets')
  if (bindings && !bindings.channelDo) out.push('channel')
  if (bindings && !bindings.serverDo) out.push('server')
  if (bindings && !bindings.rateLimitDo) out.push('rate limit')
  if (bindings && !bindings.notificationDo) out.push('notifications')
  if (health.value && !health.value.migrated) out.push('migrations')
  return out
})

onMounted(async () => {
  const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('claim') || ''
  if (fragmentToken) {
    claimToken.value = fragmentToken
    try { sessionStorage.setItem('df:owner-setup-token', fragmentToken) } catch { /* Memory fallback. */ }
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
  }
  else {
    try { claimToken.value ||= sessionStorage.getItem('df:owner-setup-token') || '' } catch { /* Memory fallback. */ }
  }

  await session.refresh(api)
  if (session.user) await navigateTo('/')
  else if (session.health?.ready) await navigateTo('/login')
  else if (session.health?.ownerSetup && claimToken.value) await loadIdentity()
})

async function loadIdentity() {
  error.value = null
  try {
    const identity = await api<{ email: string; serverName?: string }>('/api/setup/owner/identity', {
      method: 'POST',
      body: { token: claimToken.value },
    })
    ownerEmail.value = identity.email
    state.serverName = identity.serverName || session.health?.appName || state.serverName
  }
  catch (cause) {
    error.value = errorMessage(cause)
    // A wrong or stale token falls back to the token field with the error.
    claimToken.value = ''
    try { sessionStorage.removeItem('df:owner-setup-token') } catch { /* Memory fallback. */ }
  }
}

// Operator installs (Docker, Coolify) have the setup token in their deployment
// settings rather than a link from the installer.
async function usePastedToken() {
  const token = pastedToken.value.trim()
  if (!token) return
  busy.value = true
  claimToken.value = token
  try { sessionStorage.setItem('df:owner-setup-token', token) } catch { /* Memory fallback. */ }
  await loadIdentity()
  busy.value = false
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  busy.value = true
  error.value = null
  try {
    await api('/api/setup/owner', {
      method: 'POST',
      body: {
        token: claimToken.value,
        name: event.data.name,
        serverName: event.data.serverName,
        password: event.data.password,
      },
    })
    signedIn.value = true
    try { sessionStorage.removeItem('df:owner-setup-token') } catch { /* Memory fallback. */ }
    claimToken.value = ''
    await session.refresh(api)
    await navigateTo('/')
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight text-highlighted">Finish signing in</h2>
    <p class="mt-1.5 text-sm text-muted">Choose a password for your admin account on this Server.</p>

    <div v-if="!health" class="mt-6 flex items-center gap-3 text-muted">
      <UIcon name="i-ph-spinner-gap" class="size-5 animate-spin" />
      Checking server
    </div>

    <UAlert
      v-else-if="missing.length"
      color="error"
      variant="subtle"
      :title="`Not ready: ${missing.join(', ')}`"
      class="mt-6"
    />

    <p v-else-if="signedIn" role="status" class="mt-6 text-sm text-muted">Signing you in…</p>

    <template v-else-if="health?.ownerSetup">
      <form v-if="!claimToken" class="mt-7 space-y-4" @submit.prevent="usePastedToken">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UFormField
          label="Setup token"
          help="The SETUP_TOKEN of this Server's deployment. On Coolify it is SERVICE_PASSWORD_64_SETUPTOKEN. A Cloudflare install opens this page with the token already filled in."
        >
          <FormPasswordInput v-model="pastedToken" name="setupToken" autocomplete="off" size="lg" class="w-full" />
        </UFormField>
        <UButton type="submit" size="lg" label="Continue" block :loading="busy" :disabled="!pastedToken.trim()" />
      </form>
      <template v-else>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mt-6" />
        <UForm v-if="ownerEmail" :schema="schema" :state="state" autocomplete="on" class="mt-7 space-y-4" @submit="onSubmit">
          <UFormField label="Email">
            <UInput :model-value="ownerEmail" name="email" type="email" autocomplete="username" readonly size="lg" class="w-full" />
          </UFormField>
          <UFormField name="serverName" label="Server name">
            <UInput v-model="state.serverName" name="serverName" size="lg" class="w-full" />
          </UFormField>
          <UFormField name="name" label="Your name">
            <UInput v-model="state.name" name="name" size="lg" autocomplete="name" class="w-full" />
          </UFormField>
          <UFormField name="password" label="Password">
            <FormPasswordInput v-model="state.password" name="password" size="lg" autocomplete="new-password" class="w-full" />
          </UFormField>
          <UFormField name="confirm" label="Confirm password">
            <FormPasswordInput v-model="state.confirm" name="confirm" size="lg" autocomplete="new-password" class="w-full" />
          </UFormField>
          <UButton type="submit" size="lg" label="Sign in as owner" block :loading="busy" />
        </UForm>
      </template>
    </template>

    <UAlert
      v-else-if="health?.adminEnv"
      color="neutral"
      variant="subtle"
      title="Creating the owner from deployment settings…"
      class="mt-6"
    />
    <UAlert
      v-else
      color="warning"
      variant="subtle"
      title="Owner setup is not configured."
      class="mt-6"
    />
  </div>
</template>
