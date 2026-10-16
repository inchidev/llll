<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

definePageMeta({ layout: 'auth' })

const route = useRoute()
const { api } = useApi()
const busy = ref(false)
const error = ref<string | null>(null)
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')
const invalid = computed(() => !token.value || route.query.error === 'INVALID_TOKEN')
const schema = z.object({
  password: z.string().min(8, 'Use at least 8 characters'),
  confirm: z.string().min(8),
}).refine(value => value.password === value.confirm, { path: ['confirm'], message: 'Passwords do not match' })
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ password: '', confirm: '' })

async function onSubmit(event: FormSubmitEvent<Schema>) {
  if (!token.value) return
  busy.value = true
  error.value = null
  try {
    await api('/api/auth/reset-password', {
      method: 'POST',
      body: { token: token.value, newPassword: event.data.password },
    })
    await navigateTo('/login?reset=1')
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
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Choose a new password</h1>
    <p class="mt-1.5 text-sm text-muted">Use at least eight characters.</p>

    <UAlert
      v-if="invalid"
      class="mt-6"
      color="error"
      variant="subtle"
      title="This reset link is invalid or expired"
    />
    <template v-else>
      <UAlert v-if="error" class="mt-6" color="error" variant="subtle" :title="error" />
      <UForm :schema="schema" :state="state" class="mt-7 space-y-4" @submit="onSubmit">
        <UFormField name="password" label="New password">
          <FormPasswordInput v-model="state.password" size="lg" autocomplete="new-password" class="w-full" autofocus />
        </UFormField>
        <UFormField name="confirm" label="Confirm new password">
          <FormPasswordInput v-model="state.confirm" size="lg" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UButton type="submit" size="lg" label="Reset password" block :loading="busy" />
      </UForm>
    </template>

    <p class="mt-8 border-t border-default pt-5 text-sm text-muted">
      <ULink to="/login" class="font-medium text-default">Back to sign in</ULink>
    </p>
  </div>
</template>
