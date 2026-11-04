<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'manage-server-settings'] })
const route = useRoute()
await navigateTo(`/server/${route.params.serverId}/settings`, { replace: true })
</script>

<template>
  <div />
</template>
