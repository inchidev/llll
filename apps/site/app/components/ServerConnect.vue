<script setup lang="ts">
const shell = useShell()
function forget(origin: string) {
  try { shell.forget(origin) }
  catch (cause) { shell.error.value = cause instanceof Error ? cause.message : 'Could not remove this Server' }
}
</script>

<template>
  <section>
    <p class="text-sm leading-6 text-muted">Enter a Server address or invitation link. You’ll sign in on that Server.</p>
    <form class="mt-6 space-y-4" @submit.prevent="shell.submitAddress">
      <UFormField label="Server address">
        <UInput v-model="shell.address.value" placeholder="chat.example.com" autocomplete="url" required size="lg" class="w-full" :ui="{ base: 'ring-inverted/50' }" />
      </UFormField>
      <UButton type="submit" label="Connect" :loading="shell.busy.value" size="lg" block />
    </form>
    <UAlert v-if="shell.error.value" class="mt-4" color="error" :description="shell.error.value" />
    <section v-if="shell.servers.value.length" class="mt-8 border-t border-default pt-6">
      <h2 class="text-sm font-medium">Saved on this device</h2>
      <ul aria-label="Saved servers" class="mt-3 space-y-2">
        <li v-for="server in shell.servers.value" :key="server.origin" class="flex min-w-0 items-center justify-between gap-3">
          <UButton :label="server.name" color="neutral" variant="outline" class="min-w-0" @click="shell.open(server)" />
          <UButton :aria-label="`Remove ${server.name} from this device`" icon="i-ph-x" color="neutral" variant="ghost" @click="forget(server.origin)" />
        </li>
      </ul>
    </section>
  </section>
</template>
