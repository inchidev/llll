<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import type { PublicAuthConfig } from '~~/shared/types'

definePageMeta({ layout: 'auth', middleware: ['guest'] })

const { api, native } = useApi()
const busy = ref(false)
const sent = ref(false)
const error = ref<string | null>(null)
const { data: authConfig } = await useFetch<PublicAuthConfig>('/api/auth/config', {
  $fetch: native ? globalThis.$fetch : undefined,
})
const schema = z.object({ email: z.string().email('Enter a valid email') })
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ email: '' })

async function onSubmit(event: FormSubmitEvent<Schema>) {
  busy.value = true
  error.value = null
  try {
    await api('/api/auth/forgot-password', { method: 'POST', body: { email: event.data.email } })
    sent.value = true
  }
  catch (err) {
    error.value = errorMessage(err)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Reset password</h1>
    <p class="mt-1.5 text-sm text-muted">Enter your account email to receive a reset link.</p>

    <UAlert
      v-if="sent"
      class="mt-6"
      color="success"
      variant="subtle"
      title="Check your email"
      description="If an email and password account exists for that address, a reset link is on its way."
    />
    <UAlert v-else-if="!authConfig?.passwordResetEnabled" class="mt-6" color="warning" variant="subtle" title="Password reset is unavailable" />
    <template v-else>
      <UAlert v-if="error" class="mt-6" color="error" variant="subtle" :title="error" />
      <UForm :schema="schema" :state="state" class="mt-7 space-y-4" @submit="onSubmit">
        <UFormField name="email" label="Email">
          <UInput v-model="state.email" type="email" size="lg" autocomplete="email" placeholder="you@example.com" class="w-full" autofocus />
        </UFormField>
        <UButton type="submit" size="lg" label="Send reset link" block :loading="busy" />
      </UForm>
    </template>

    <p class="mt-8 border-t border-default pt-5 text-sm text-muted">
      <ULink to="/login" class="font-medium text-default">Back to sign in</ULink>
    </p>
  </div>
</template>
