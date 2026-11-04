<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import type { AuthLoginMethod, PublicAuthConfig } from '~~/shared/types'
import { DEFAULT_APP_NAME } from '~~/shared/app-branding'

definePageMeta({ layout: 'auth', middleware: ['guest'] })

const session = useSessionStore()
const appName = computed(() => session.health?.appName || DEFAULT_APP_NAME)
const route = useRoute()
const toast = useToast()
const busy = ref(false)
const socialBusy = ref<AuthLoginMethod | null>(null)
const error = ref<string | null>(null)
const { api, native, serverUrl, serverOrigin } = useApi()
const { data: authConfig } = await useFetch<PublicAuthConfig>('/api/auth/config', {
  $fetch: native ? globalThis.$fetch : undefined,
})

const schema = z.object({
  login: z.string().trim().min(1, 'Enter your username or email'),
  password: z.string().min(1, 'Password is required'),
})
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ login: '', password: '' })

onMounted(async () => {
  if (route.query.verified === '1') toast.add({ title: 'Email verified.', color: 'success' })
  if (route.query.verify_error === 'taken') toast.add({ title: 'Another account already uses that email.', color: 'error' })
  if (route.query.verify_error === 'invalid') toast.add({ title: 'That email link is invalid or expired.', color: 'error' })
  await session.refresh(api)
  if (session.user) {
    await navigateTo(safeNextPath(), { external: safeNextPath().startsWith('/api/auth/connection/authorize?') })
    return
  }
  if (session.health && !session.health.ready) await navigateTo('/setup')
  if (route.query.reset === '1') toast.add({ title: 'Password reset. You can sign in.', color: 'success' })
})

async function onSubmit(event: FormSubmitEvent<Schema>) {
  busy.value = true
  error.value = null
  try {
    await session.login(event.data.login, event.data.password, api)
    if (session.user?.onboardingRequired) {
      await navigateTo({ path: '/signup/accept', query: { next: safeNextPath() } })
      return
    }
    await navigateTo(safeNextPath(), { external: safeNextPath().startsWith('/api/auth/connection/authorize?') })
  }
  catch (err) {
    error.value = errorMessage(err)
  }
  finally {
    busy.value = false
  }
}

function safeNextPath() {
  const next = typeof route.query.return_to === 'string' ? route.query.return_to : typeof route.query.next === 'string' ? route.query.next : '/'
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

async function signInWith(provider: Exclude<AuthLoginMethod, 'password'>) {
  socialBusy.value = provider
  error.value = null
  try {
    const callbackURL = native
      ? serverUrl(safeNextPath())
      : new URL(safeNextPath(), window.location.origin).toString()
    const errorCallbackURL = native
      ? serverUrl('/login')
      : `${window.location.origin}/login`
    const res = await plainFetch<{ url?: string | null }>('/api/auth/social', {
      method: 'POST',
      body: {
        provider,
        callbackURL,
        errorCallbackURL,
        inviteCode: inviteCode.value ?? undefined,
        mode: 'login',
      },
    })
    if (!res.url) throw new Error('Sign-in did not return a redirect')
    window.location.assign(res.url)
  }
  catch (err) {
    error.value = errorMessage(err)
    socialBusy.value = null
  }
}

const socialProviders = computed(() => [
  { id: 'github' as const, label: 'Continue with GitHub', icon: 'i-ph-github-logo' },
  { id: 'google' as const, label: 'Continue with Google', icon: 'i-ph-google-logo' },
  { id: 'linkedin' as const, label: 'Continue with LinkedIn', icon: 'i-ph-linkedin-logo' },
  { id: 'twitter' as const, label: 'Continue with X', icon: 'i-ph-x-logo' },
].filter(provider => !native && authConfig.value?.methods[provider.id]))

// The Shortcut opens the phone's default browser, which may not be the one signed in.
const markingNext = computed(() => safeNextPath().startsWith('/projects/mark/'))

const inviteCode = computed(() => {
  const next = typeof route.query.next === 'string' ? route.query.next : ''
  const match = next.match(/^\/invite\/([^/?#]+)/u)
  return match?.[1] ? decodeURIComponent(match[1]) : null
})

const signupPath = computed(() => inviteCode.value
  ? `/signup?invite=${encodeURIComponent(inviteCode.value)}`
  : '/signup')

const showPasswordForm = computed(() => Boolean(authConfig.value?.methods.password))

const canCreateAccount = computed(() => Boolean(
  inviteCode.value
    ? authConfig.value?.inviteSignupEnabled || (!native && socialProviders.value.length)
    : authConfig.value?.signupEnabled && (authConfig.value.emailSignupEnabled || (!native && socialProviders.value.length)),
))
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight text-highlighted">Sign in</h2>
    <p class="mt-1.5 text-sm text-muted">
      Use your account on {{ appName }}.
    </p>

    <ULink
      v-if="native && serverOrigin"
      to="/servers"
      class="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs text-muted hover:text-default"
    >
      <UIcon name="i-ph-globe" class="size-3.5 shrink-0" />
      <span class="truncate font-mono">{{ serverOrigin }}</span>
    </ULink>

    <UAlert
      v-if="markingNext"
      class="mb-4"
      color="success"
      variant="subtle"
      title="Your recording is saved"
      description="Sign in here once, and from now on it opens straight on the marking page."
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="mt-6"
    />

    <template v-if="socialProviders.length">
      <UButton
        v-for="provider in socialProviders"
        :key="provider.id"
        class="mt-3 first:mt-7"
        size="lg"
        color="neutral"
        variant="outline"
        :icon="provider.icon"
        :label="provider.label"
        block
        :loading="socialBusy === provider.id"
        :disabled="Boolean(socialBusy)"
        @click="signInWith(provider.id)"
      />
      <USeparator label="or" class="my-6" />
    </template>

    <UForm v-if="showPasswordForm" :schema="schema" :state="state" :class="socialProviders.length ? 'space-y-4' : 'mt-7 space-y-4'" @submit="onSubmit">
      <UFormField name="login" label="Username or email">
        <UInput
          v-model="state.login"
          size="lg"
          autocomplete="username"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          class="w-full"
        />
      </UFormField>
      <UFormField name="password" label="Password">
        <template #hint>
          <ULink to="/forgot-password" class="text-sm font-medium text-default">Forgot password?</ULink>
        </template>
        <FormPasswordInput
          v-model="state.password"
          size="lg"
          autocomplete="current-password"
          class="w-full"
        />
      </UFormField>
      <UButton type="submit" size="lg" label="Sign in" block :loading="busy" class="mt-2" />
    </UForm>

    <div v-if="canCreateAccount || session.health?.ready === false" class="mt-8 space-y-2 border-t border-default pt-5 text-sm text-muted">
      <p v-if="canCreateAccount">
        New here?
        <ULink :to="signupPath" class="text-default font-medium">Create account</ULink>
      </p>

      <p v-if="session.health?.ready === false">
        First machine?
        <ULink to="/setup" class="text-default font-medium">Run setup</ULink>
      </p>
    </div>
    <UButton to="/recover" label="Use a recovery key" variant="link" class="mt-4" />
  </div>
</template>
