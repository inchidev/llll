<script setup lang="ts">
defineProps<{ linked?: boolean }>()
</script>
<template><component :is="linked === false ? 'span' : resolveComponent('NuxtLink')" :to="linked === false ? undefined : '/'" aria-label="L4 home" class="inline-flex items-center gap-3"><BrandMark class="size-7" /></component></template>