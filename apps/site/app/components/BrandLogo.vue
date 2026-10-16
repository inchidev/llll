<script setup lang="ts">
defineProps<{ linked?: boolean }>()
</script>
<template><component :is="linked === false ? 'span' : resolveComponent('NuxtLink')" :to="linked === false ? undefined : '/'" aria-label="L4 home" class="inline-flex items-center gap-3"><svg viewBox="0 0 44 32" class="h-7 w-10" aria-hidden="true"><rect v-for="x in [0,12,24,36]" :key="x" :x="x" y="0" width="8" height="32" rx="2" fill="currentColor" /></svg><span class="text-xl font-semibold">L4</span></component></template>