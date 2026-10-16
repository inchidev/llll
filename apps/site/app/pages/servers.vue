<script setup lang="ts">
const sandboxInstallation = 'https://sandbox.llll.gg'
const serverId = ref('')
const error = ref('')
function openServer() {
  error.value = ''
  const id = serverId.value.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    error.value = 'Enter a server ID (UUIDv4).'
    return
  }
  navigateTo('/' + id)
}
</script>

<template>
  <div class="min-h-screen bg-default text-default">
    <UContainer class="max-w-2xl py-16">
      <h1 class="text-3xl font-semibold tracking-tight">Try a server</h1>
      <p class="mt-3 text-muted">Servers live at <code>llll.gg/&lt;server_id&gt;</code>, embedded from their installation. No separate app worker — the sandbox installation runs at <code>sandbox.llll.gg</code> and you open its servers here.</p>
      <div class="mt-8 rounded-md border border-default bg-elevated p-6">
        <h2 class="text-lg font-semibold">Sandbox</h2>
        <p class="mt-2 text-sm text-muted">Open the shared sandbox installation in the shell, then pick a server.</p>
        <UButton :to="`/open?installation=${sandboxInstallation}`" label="Open sandbox.llll.gg in the shell" trailing-icon="i-ph-arrow-right" class="mt-4" />
      </div>
      <form class="mt-8 space-y-4" @submit.prevent="openServer">
        <UFormField label="Server ID"><UInput v-model="serverId" placeholder="xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx" class="w-full" size="xl" autocomplete="off" /></UFormField>
        <UAlert v-if="error" color="error" :description="error" />
        <UButton type="submit" label="Open server" size="lg" block />
      </form>
      <p class="mt-6 text-sm text-muted"><NuxtLink to="/open" class="hover:text-highlighted">Or connect any installation by address →</NuxtLink></p>
    </UContainer>
  </div>
</template>
