<script setup lang="ts">
const { $pwa } = useNuxtApp()
</script>
<template>
  <div v-if="$pwa?.waiting.value" class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-default bg-elevated px-3 py-2 text-xs" role="status">
    <span>An L4 update is ready.</span>
    <UButton data-client-update-action label="Update now" size="xs" :loading="$pwa.updating.value" @click="$pwa.update()" />
    <span v-if="$pwa.error.value" class="w-full text-center text-error">{{ $pwa.error.value }}</span>
  </div>
</template>
