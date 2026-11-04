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
const schema = z.object({ login: z.string().trim().min(1, 'Enter your username or email') })
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ login: '' })

async function onSubmit(event: FormSubmitEvent<Schema>) {
  busy.value = true
  error.value = null
  try {
    await api('/api/auth/forgot-password', { method: 'POST', body: { login: event.data.login } })
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
    <h2 class="text-2xl font-semibold tracking-tight text-highlighted">Reset password</h2>
    <p v-if="authConfig?.passwordResetEnabled" class="mt-1.5 text-sm text-muted">We can email a reset link if your account has a verified email.</p>

    <UAlert
      v-if="sent"
      class="mt-6"
      color="success"
      variant="subtle"
      title="Check your email"
      description="If this account has a verified email, a reset link is on its way. If nothing arrives, ask the Server's Owner for a reset link."
    />
    <UAlert
      v-else-if="!authConfig?.passwordResetEnabled"
      class="mt-6"
      color="neutral"
      variant="subtle"
      title="Ask the Server's Owner"
      description="This Server can't send email. The Owner, or someone who manages members, can give you a one-time reset link. If you are the Owner, use your recovery key."
    />
    <template v-else>
      <UAlert v-if="error" class="mt-6" color="error" variant="subtle" :title="error" />
      <UForm :schema="schema" :state="state" class="mt-7 space-y-4" @submit="onSubmit">
        <UFormField name="login" label="Username or email">
          <UInput v-model="state.login" size="lg" autocomplete="username" autocapitalize="none" class="w-full" autofocus />
        </UFormField>
        <UButton type="submit" size="lg" label="Send reset link" block :loading="busy" />
      </UForm>
    </template>

    <p class="mt-8 border-t border-default pt-5 text-sm text-muted">
      <ULink to="/login" class="font-medium text-default">Back to sign in</ULink>
      <span class="mx-2">·</span>
      <ULink to="/recover" class="font-medium text-default">Use a recovery key</ULink>
    </p>
  </div>
</template>
