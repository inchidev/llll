<script setup lang="ts">
const email = ref('')
const code = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)
const recovered = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await adminFetch('/api/recover', { method: 'POST', body: { email: email.value, code: code.value, password: password.value } })
    recovered.value = true
    code.value = ''
    password.value = ''
  }
  catch (cause) {
    error.value = failureMessage(cause)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center bg-default px-4">
    <div v-if="recovered" class="w-full max-w-sm space-y-5">
      <UAlert color="success" title="Password reset" description="Your recovery code was used and all previous sessions were signed out. Sign in with your new password." />
      <UButton to="/login" label="Sign in" block />
    </div>
    <form v-else class="w-full max-w-sm space-y-5" @submit.prevent="submit">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Recover your Admin</h1>
        <p class="mt-1 text-sm text-muted">Use your Admin email and one unused recovery code. No email will be sent.</p>
      </div>
      <UAlert v-if="error" color="error" :title="error" />
      <UFormField label="Admin email">
        <UInput v-model="email" type="email" autocomplete="username" required class="w-full" />
      </UFormField>
      <UFormField label="Recovery code">
        <UInput v-model="code" autocomplete="off" required class="w-full font-mono" />
      </UFormField>
      <UFormField label="New password" help="At least 12 characters.">
        <UInput v-model="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256" class="w-full" />
      </UFormField>
      <UButton type="submit" label="Reset password" block :loading="busy" />
      <NuxtLink to="/login" class="block text-sm text-primary">Back to sign in</NuxtLink>
      <p class="text-xs text-dimmed">Lost both your password and recovery codes? In your Cloudflare dashboard, set a new <code>ADMIN_CLAIM_TOKEN</code> secret on this Admin Worker, then open <code>/claim#token=…</code>. This replaces the password and all recovery codes.</p>
    </form>
  </div>
</template>
