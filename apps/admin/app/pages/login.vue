<script setup lang="ts">
const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  loading.value = true
  error.value = ''
  try {
    await adminFetch('/api/login', { method: 'POST', body: { email: email.value, password: password.value } })
    await navigateTo('/', { replace: true })
  }
  catch (cause) {
    error.value = failureMessage(cause, 'Sign-in failed')
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center bg-default px-4">
    <form class="w-full max-w-sm space-y-5" @submit.prevent="submit">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">L4 Admin</h1>
        <p class="mt-1 text-sm text-muted">Manage the L4 workspaces in this Cloudflare account.</p>
      </div>
      <UAlert v-if="error" color="error" :title="error" />
      <UFormField label="Email">
        <UInput v-model="email" type="email" autocomplete="username" class="w-full" autofocus />
      </UFormField>
      <UFormField label="Password">
        <UInput v-model="password" type="password" autocomplete="current-password" class="w-full" />
      </UFormField>
      <UButton type="submit" label="Sign in" block :loading="loading" />
      <NuxtLink to="/recover" class="block text-sm text-primary">Forgot your password? Use a recovery code</NuxtLink>
    </form>
  </div>
</template>
