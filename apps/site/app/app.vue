<script setup lang="ts">
const route = useRoute()
const shell = computed(() => route.path === '/open' || /^\/[a-f0-9]{8}-[a-f0-9-]{27}(?:\/|$)/i.test(route.path))
useHead({ title: computed(() => shell.value ? 'L4' : undefined) })
</script>
<template><UApp><ClientOnly><InstallationShell v-show="shell" /></ClientOnly><NuxtPage v-if="!shell" /></UApp></template>