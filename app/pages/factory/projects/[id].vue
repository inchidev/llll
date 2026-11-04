<script setup lang="ts">
// Factory's pages live under `/projects`. Keep these links working.
definePageMeta({ middleware: [to => navigateTo(`/projects/${encodeURIComponent(String(to.params.id))}`, { replace: true })] })
</script>
<template>
  <div />
</template>
