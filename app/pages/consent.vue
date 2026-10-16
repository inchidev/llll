<script setup lang="ts">
definePageMeta({ layout: 'default' })
const connections = useInstallations()
const info = ref<{ client: { client_name?: string; client_id?: string }; scope: string; claims?: string } | null>(null)
const error = ref('')
const busy = ref(false)
async function decide(accept: boolean) {
  busy.value = true
  try {
    const result = await connections.request<{ url?: string; redirect_uri?: string }>(location.origin, '/api/auth/oauth2/consent', { method: 'POST', body: { accept, oauth_query: location.search.slice(1) } })
    const target = result.url || result.redirect_uri
    if (target) location.assign(target)
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
onMounted(async () => {
  try { info.value = await connections.request(location.origin, `/api/installation/consent?query=${encodeURIComponent(location.search.slice(1))}`) }
  catch (cause) { error.value = errorMessage(cause) }
})
</script>
<template>
  <main class="grid h-full place-items-center overflow-y-auto p-6">
    <section class="w-full max-w-md space-y-5 rounded-2xl border border-default p-6">
      <p class="text-sm font-semibold text-primary">L4 account</p><h1 class="text-2xl font-semibold">Connect your account</h1>
      <UAlert v-if="error" color="error" :title="error" />
      <template v-if="info"><p><strong>{{ info.client.client_name || info.client.client_id }}</strong> requests access to your account.</p><p class="text-sm text-muted">Permissions: {{ info.scope }}</p><pre v-if="info.claims" class="overflow-auto text-xs">{{ info.claims }}</pre><div class="flex gap-3"><UButton label="Allow" :loading="busy" @click="decide(true)" /><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="decide(false)" /></div></template>
    </section>
  </main>
</template>
