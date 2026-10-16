<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'manage-workspace-settings'] })
const route = useRoute()
await navigateTo(`/w/${route.params.workspaceId}/settings`, { replace: true })
</script>

<template>
  <div />
</template>
