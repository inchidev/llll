<script setup lang="ts">
import type { PublicOnboardingConfig, SessionUser } from '~~/shared/types'

definePageMeta({ layout: 'auth', middleware: ['auth'] })

const route = useRoute()
const session = useSessionStore()
const { api, native } = useApi()
const accepted = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const { data: onboardingResponse } = await useFetch<{ onboarding: PublicOnboardingConfig }>('/api/onboarding', {
  $fetch: native ? globalThis.$fetch : undefined,
})
const onboarding = computed(() => onboardingResponse.value?.onboarding ?? null)

function safeNextPath() {
  const next = typeof route.query.next === 'string' ? route.query.next : '/'
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

onMounted(async () => {
  if (!onboarding.value?.acceptanceRequired) {
    await session.refresh(api)
    await navigateTo(safeNextPath())
  }
})

async function accept() {
  if (!accepted.value || !onboarding.value?.revisionId) return
  busy.value = true
  error.value = null
  try {
    const response = await api<{ user: SessionUser }>('/api/onboarding/accept', {
      method: 'POST',
      body: {
        accepted: true,
        onboardingRevisionId: onboarding.value.revisionId,
      },
    })
    session.user = response.user
    await navigateTo(safeNextPath())
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
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Review workspace documents</h1>
    <p class="mt-1.5 text-sm text-muted">Accept the current version before joining this workspace.</p>
    <UAlert v-if="error" class="mt-6" color="error" variant="subtle" :title="error" />
    <template v-if="onboarding?.acceptanceRequired">
      <OnboardingAgreement v-model="accepted" class="mt-7" :onboarding="onboarding" />
      <UButton class="mt-6" size="lg" label="Continue" block :loading="busy" :disabled="!accepted" @click="accept" />
    </template>
  </div>
</template>
