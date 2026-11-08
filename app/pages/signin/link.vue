<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const session = useSessionStore()
const { api } = useApi()
const error = ref<string | null>(null)

// The token travels in the fragment, so it reaches no log on the way; it works once and for ten minutes.
onMounted(async () => {
  const token = window.location.hash.slice(1).trim()
  window.history.replaceState({}, '', window.location.pathname)
  if (!token) {
    error.value = 'This sign-in link is incomplete. Open it again from where you got it.'
    return
  }
  try {
    await api('/api/auth/link', { method: 'POST', body: { token } })
    await session.refresh(api)
    await navigateTo('/')
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
})
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight text-highlighted">Signing you in</h2>
    <p class="mt-1.5 text-sm text-muted">One moment while this link opens your account on this Server.</p>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mt-6" />
    <p v-if="error" class="mt-4 text-sm text-muted">
      Ask for a new link where you came from, or <NuxtLink to="/login" class="text-primary">sign in with a password</NuxtLink> if you have set one.
    </p>
    <div v-else class="mt-6 flex items-center gap-3 text-muted" role="status">
      <UIcon name="i-ph-spinner-gap" class="size-5 animate-spin" />
      Opening your account
    </div>
  </div>
</template>
