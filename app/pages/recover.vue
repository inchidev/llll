<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
definePageMeta({ layout: 'auth' })
const { api } = useApi()
const schema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^[a-f0-9]{64}$/, 'Enter your saved recovery key'),
  password: z.string().min(12, 'Use at least 12 characters'),
})
const state = reactive({ email: '', code: '', password: '' })
const error = ref('')
const busy = ref(false)
async function recover(event: FormSubmitEvent<z.output<typeof schema>>) {
  busy.value = true
  error.value = ''
  try {
    await api('/api/auth/recover', { method: 'POST', body: event.data })
    await navigateTo('/login?reset=1')
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main class="grid min-h-full place-items-center p-6">
    <section class="w-full max-w-sm space-y-6">
      <h1 class="text-2xl font-semibold">Recover your account</h1>
      <p class="text-muted">
        Use the recovery key saved from this Server. Recovery replaces your
        password and signs out every session here.
      </p>
      <UForm :schema="schema" :state="state" class="space-y-4" @submit="recover"
        ><UFormField name="email" label="Email"
          ><UInput
            v-model="state.email"
            type="email"
            class="w-full" /></UFormField
        ><UFormField name="code" label="Recovery key"
          ><UInput
            v-model="state.code"
            type="password"
            class="w-full" /></UFormField
        ><UFormField name="password" label="New password"
          ><UInput
            v-model="state.password"
            type="password"
            autocomplete="new-password"
            class="w-full" /></UFormField
        ><UAlert v-if="error" :title="error" color="error" /><UButton
          type="submit"
          label="Recover account"
          :loading="busy"
          block /></UForm
      ><UButton to="/login" label="Back to sign in" variant="link" />
    </section>
  </main>
</template>
