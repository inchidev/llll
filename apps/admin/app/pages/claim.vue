<script setup lang="ts">
import type { AdminSession } from '../composables/useAdmin'

const session = useState<AdminSession | null>('admin-session')
const token = ref('')
const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)
const codes = ref<string[]>([])

function readToken() {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const value = hash.get('token')
  if (!value) return
  token.value = value
  // Keep the one-time token out of history and screenshots.
  history.replaceState(null, '', '/claim')
}

onMounted(() => {
  readToken()
  window.addEventListener('hashchange', readToken)
})
onBeforeUnmount(() => window.removeEventListener('hashchange', readToken))

async function submit() {
  loading.value = true
  error.value = ''
  try {
    const result = await adminFetch<{ codes: string[] }>('/api/claim', { method: 'POST', body: { token: token.value, email: email.value, password: password.value } })
    codes.value = result.codes
    password.value = ''
    token.value = ''
  }
  catch (cause) {
    error.value = failureMessage(cause, 'The Admin could not be claimed')
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center bg-default px-4">
    <RecoveryCodes v-if="codes.length" :codes="codes" class="w-full max-w-lg" @saved="navigateTo('/', { replace: true })" />
    <form v-else class="w-full max-w-sm space-y-5" @submit.prevent="submit">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">{{ session?.claimed ? 'Recover the Admin' : 'Claim your L4 Admin' }}</h1>
        <p class="mt-1 text-sm text-muted">
          This Admin manages L4 in your Cloudflare account. Choose how you will sign in to it.
        </p>
      </div>
      <UAlert v-if="error" color="error" :title="error" />
      <UAlert
        v-if="!token"
        color="warning"
        title="Open the private setup link"
        description="The link from llll.gg, or a recovery link with a new ADMIN_CLAIM_TOKEN, carries the token."
      />
      <UFormField label="Email">
        <UInput v-model="email" type="email" autocomplete="username" class="w-full" />
      </UFormField>
      <UFormField label="Password" help="At least 12 characters.">
        <UInput v-model="password" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>
      <UButton type="submit" :label="session?.claimed ? 'Reset owner' : 'Claim Admin'" block :loading="loading" :disabled="!token" />
    </form>
  </div>
</template>
