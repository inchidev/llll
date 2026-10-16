<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import type { AuthLoginMethod, PublicAuthConfig, PublicOnboardingConfig, SessionUser } from '~~/shared/types'

definePageMeta({ layout: 'auth', middleware: ['guest'] })

const route = useRoute()
const toast = useToast()
const session = useSessionStore()
const busy = ref(false)
const socialBusy = ref<AuthLoginMethod | null>(null)
const sent = ref(false)
const error = ref<string | null>(null)
const captchaToken = ref('')
const captchaKey = ref(0)
const { api, native } = useApi()
const inviteCode = computed(() => typeof route.query.invite === 'string' ? route.query.invite : undefined)
const [{ data: authConfig }, { data: onboardingResponse }] = await Promise.all([
  useFetch<PublicAuthConfig>('/api/auth/config', { $fetch: native ? globalThis.$fetch : undefined }),
  useFetch<{ onboarding: PublicOnboardingConfig }>('/api/onboarding', { $fetch: native ? globalThis.$fetch : undefined }),
])
const onboarding = computed(() => onboardingResponse.value?.onboarding ?? null)

const schema = computed(() => z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters'),
  confirm: z.string().min(8),
  accepted: z.boolean(),
}).superRefine((value, context) => {
  if (value.password !== value.confirm) context.addIssue({ code: 'custom', path: ['confirm'], message: 'Passwords do not match' })
  if (onboarding.value?.acceptanceRequired && !value.accepted) {
    context.addIssue({ code: 'custom', path: ['accepted'], message: 'Accept the published workspace documents' })
  }
}))
type Schema = { name: string; email: string; password: string; confirm: string; accepted: boolean }
const state = reactive<Partial<Schema>>({ name: '', email: '', password: '', confirm: '', accepted: false })

const socialProviders = computed(() => [
  { id: 'github' as const, label: 'Continue with GitHub', icon: 'i-ph-github-logo' },
  { id: 'google' as const, label: 'Continue with Google', icon: 'i-ph-google-logo' },
  { id: 'linkedin' as const, label: 'Continue with LinkedIn', icon: 'i-ph-linkedin-logo' },
  { id: 'twitter' as const, label: 'Continue with X', icon: 'i-ph-x-logo' },
  { id: 'telegram' as const, label: 'Continue with Telegram', icon: 'i-ph-telegram-logo' },
].filter(provider => !native && authConfig.value?.methods[provider.id]))
const admissionAllowed = computed(() => authConfig.value?.registrationMode === 'open' || Boolean(inviteCode.value))
const emailAllowed = computed(() => Boolean(admissionAllowed.value && authConfig.value?.emailSignupEnabled))
const allowed = computed(() => Boolean(admissionAllowed.value && (emailAllowed.value || socialProviders.value.length)))
const captchaRequired = computed(() => Boolean(authConfig.value?.turnstile.enabled && authConfig.value.turnstile.siteKey))

async function onSubmit(event: FormSubmitEvent<Schema>) {
  if (captchaRequired.value && !captchaToken.value) {
    error.value = 'Complete the security check'
    return
  }
  busy.value = true
  error.value = null
  try {
    const result = await api<{ ok: true, verificationRequired: boolean, user?: SessionUser }>('/api/auth/signup', {
      method: 'POST',
      headers: captchaToken.value ? { 'x-captcha-response': captchaToken.value } : undefined,
      body: {
        name: event.data.name,
        email: event.data.email,
        password: event.data.password,
        inviteCode: inviteCode.value,
        accepted: event.data.accepted,
        onboardingRevisionId: onboarding.value?.revisionId ?? null,
      },
    })
    if (result.verificationRequired) {
      sent.value = true
    }
    else {
      session.user = result.user ?? null
      if (!session.user) await session.refresh(api)
      await navigateTo(inviteCode.value ? `/invite/${encodeURIComponent(inviteCode.value)}` : '/')
    }
  }
  catch (err) {
    error.value = errorMessage(err)
    toast.add({ title: error.value, color: 'error' })
    captchaToken.value = ''
    captchaKey.value += 1
  }
  finally {
    busy.value = false
  }
}

async function signUpWith(provider: Exclude<AuthLoginMethod, 'email'>) {
  if (onboarding.value?.acceptanceRequired && !state.accepted) {
    error.value = 'Accept the published workspace documents'
    return
  }
  socialBusy.value = provider
  error.value = null
  try {
    const next = inviteCode.value ? `/invite/${encodeURIComponent(inviteCode.value)}` : '/'
    const callbackURL = new URL(next, window.location.origin).toString()
    const errorPath = inviteCode.value ? `/signup?invite=${encodeURIComponent(inviteCode.value)}` : '/signup'
    const response = await $fetch<{ url?: string | null }>('/api/auth/social', {
      method: 'POST',
      body: {
        provider,
        callbackURL,
        errorCallbackURL: new URL(errorPath, window.location.origin).toString(),
        inviteCode: inviteCode.value,
        mode: 'signup',
        accepted: Boolean(state.accepted),
        onboardingRevisionId: onboarding.value?.revisionId ?? null,
      },
    })
    if (!response.url) throw new Error('Sign-up did not return a redirect')
    window.location.assign(response.url)
  }
  catch (err) {
    error.value = errorMessage(err)
    toast.add({ title: error.value, color: 'error' })
    socialBusy.value = null
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Create account</h1>

    <UAlert
      v-if="sent"
      color="success"
      variant="subtle"
      title="Check your email"
      description="Open the verification link, then sign in."
      class="mt-6"
    />
    <UAlert v-else-if="!allowed" color="warning" variant="subtle" title="Signup is not available" class="mt-6" />
    <template v-else>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mt-6" />
      <UForm :schema="schema" :state="state" class="mt-8 space-y-4" @submit="onSubmit">
        <template v-if="emailAllowed">
          <UFormField name="name" label="Name">
            <UInput v-model="state.name" size="lg" autocomplete="name" class="w-full" />
          </UFormField>
          <UFormField name="email" label="Email">
            <UInput v-model="state.email" type="email" size="lg" autocomplete="email" class="w-full" />
          </UFormField>
          <UFormField name="password" label="Password">
            <FormPasswordInput v-model="state.password" size="lg" autocomplete="new-password" class="w-full" />
          </UFormField>
          <UFormField name="confirm" label="Confirm password">
            <FormPasswordInput v-model="state.confirm" size="lg" autocomplete="new-password" class="w-full" />
          </UFormField>
        </template>
        <AuthTurnstileWidget
          v-if="emailAllowed && authConfig?.turnstile.enabled && authConfig.turnstile.siteKey"
          :key="captchaKey"
          :site-key="authConfig.turnstile.siteKey"
          @update:model-value="captchaToken = $event"
        />
        <UFormField v-if="onboarding?.acceptanceRequired" name="accepted">
          <OnboardingAgreement v-model="state.accepted" :onboarding="onboarding" />
        </UFormField>
        <UButton
          v-if="emailAllowed"
          type="submit"
          size="lg"
          label="Create account"
          block
          :loading="busy"
          :disabled="(captchaRequired && !captchaToken) || Boolean(onboarding?.acceptanceRequired && !state.accepted)"
        />
        <template v-if="socialProviders.length">
          <USeparator :label="emailAllowed ? 'or' : undefined" class="my-5" />
          <UButton
            v-for="provider in socialProviders"
            :key="provider.id"
            type="button"
            size="lg"
            color="neutral"
            variant="outline"
            :icon="provider.icon"
            :label="provider.label"
            block
            :loading="socialBusy === provider.id"
            :disabled="Boolean(socialBusy) || Boolean(onboarding?.acceptanceRequired && !state.accepted)"
            @click="signUpWith(provider.id)"
          />
        </template>
      </UForm>
    </template>

    <p class="mt-8 border-t border-default pt-5 text-sm text-muted">
      Already have an account?
      <ULink :to="inviteCode ? `/login?next=/invite/${encodeURIComponent(inviteCode)}` : '/login'" class="text-default font-medium">Sign in</ULink>
    </p>
  </div>
</template>
