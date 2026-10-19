<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

definePageMeta({ layout: 'auth' })

const session = useSessionStore()
const { api } = useApi()
const health = computed(() => session.health)
const busy = ref(false)
const error = ref<string | null>(null)
const claimToken = ref('')
const ownerEmail = ref('')

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  password: z.string().min(12, 'Use at least 12 characters'),
  confirm: z.string().min(12),
}).superRefine((value, context) => {
  if (value.password !== value.confirm) context.addIssue({ code: 'custom', path: ['confirm'], message: 'Passwords do not match' })
})
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ name: '', password: '', confirm: '' })

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
    sessionStorage.setItem('df:owner-setup-token', fragmentToken)
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
  }
  else {
    claimToken.value = sessionStorage.getItem('df:owner-setup-token') || ''
  }

  await session.refresh(api)
  if (session.user) await navigateTo('/')
  else if (session.health?.ready) await navigateTo('/login')
  else if (session.health?.ownerSetup && claimToken.value) {
    try {
      const identity = await api<{ email: string }>('/api/setup/owner/identity', {
        method: 'POST',
        body: { token: claimToken.value },
      })
      ownerEmail.value = identity.email
    }
    catch (cause) {
      error.value = errorMessage(cause)
    }
  }
})

async function onSubmit(event: FormSubmitEvent<Schema>) {
  busy.value = true
  error.value = null
  try {
    await api('/api/setup/owner', {
      method: 'POST',
      body: {
        token: claimToken.value,
        name: event.data.name,
        password: event.data.password,
      },
    })
    sessionStorage.removeItem('df:owner-setup-token')
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

    <template v-else-if="health?.ownerSetup">
      <UAlert
        v-if="!claimToken"
        color="warning"
        variant="subtle"
        title="Continue from the installer in the browser you used to create this Server."
        class="mt-6"
      />
      <template v-else>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mt-6" />
        <UForm v-if="ownerEmail" :schema="schema" :state="state" autocomplete="on" class="mt-7 space-y-4" @submit="onSubmit">
          <UFormField label="Email">
            <UInput :model-value="ownerEmail" name="email" type="email" autocomplete="username" readonly size="lg" class="w-full" />
          </UFormField>
          <UFormField name="name" label="Name">
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
