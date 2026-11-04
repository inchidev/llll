<script setup lang="ts">
definePageMeta({ layout: 'auth' })
const error = ref('')
onMounted(async () => {
  const hash = new URLSearchParams(location.hash.slice(1))
  const code = hash.get('llll_connection')
  if (code && window.opener && /^[a-f0-9]{64}$/.test(code)) {
    history.replaceState(history.state, '', location.pathname)
    window.opener.postMessage(
      { type: 'llll-local-login', code, state: hash.get('state') },
      location.origin,
    )
    return
  }
  await navigateTo('/login', { replace: true })
})
</script>
<template>
  <main class="grid h-full place-items-center p-6">
    <UAlert v-if="error" :title="error" color="error" />
    <p v-else>Connecting your account…</p>
  </main>
</template>
