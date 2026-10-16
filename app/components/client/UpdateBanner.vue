<script setup lang="ts">
const { $pwa } = useNuxtApp()
</script>
<template>
  <div v-if="$pwa?.waiting.value" class="flex items-center justify-center gap-3 border-b border-default bg-elevated px-4 py-2 text-xs" role="status"><span>A new L4 client is ready.</span><UButton label="Update now" size="xs" :loading="$pwa.updating.value" @click="$pwa.update()" /><span v-if="$pwa.error.value" class="text-error">{{ $pwa.error.value }}</span></div>
</template>
