<script setup lang="ts">
import { normalizeRoutePath } from './utils/shell-route'

const route = useRoute()
const path = computed(() => normalizeRoutePath(route.path))
const shell = computed(() => path.value === '/open' || path.value === '/deploy' || /^\/[a-f0-9]{8}-[a-f0-9-]{27}(?:\/|$)/i.test(path.value))
useHead({ title: computed(() => path.value === '/deploy' ? 'Install L4 on your infrastructure' : shell.value ? 'L4' : undefined) })
</script>
<template><UApp><ClientOnly><InstallationShell v-show="shell" /></ClientOnly><div v-show="!shell"><NuxtPage /></div></UApp></template>