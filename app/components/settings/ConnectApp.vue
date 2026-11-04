<script setup lang="ts">
import { renderSVG } from 'uqr'

const { serverUrl } = useApi()
const address = computed(() => new URL(serverUrl('/'), window.location.href).origin)
const code = computed(() => renderSVG(address.value, { border: 1 }))
</script>

<template>
  <section class="flex items-center gap-4 rounded-lg border border-default p-4">
    <!-- eslint-disable-next-line vue/no-v-html -- uqr builds this from the Server's own address. -->
    <div class="size-28 shrink-0 overflow-hidden rounded bg-white text-black" aria-hidden="true" v-html="code" />
    <div class="min-w-0">
      <h2 class="font-medium text-highlighted">Connect the L4 app</h2>
      <p class="mt-1 text-sm text-muted">Scan this code in the app on your phone. You sign in there with your Account.</p>
      <p class="mt-2 break-all font-mono text-xs text-muted">{{ address }}</p>
    </div>
  </section>
</template>
