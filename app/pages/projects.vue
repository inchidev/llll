<script setup lang="ts">
// Projects live in Factory. Keep earlier links, including ?project=<id>, working.
definePageMeta({ middleware: [to => navigateTo(to.query.project ? `/factory/projects/${encodeURIComponent(String(to.query.project))}` : '/factory', { replace: true })] })
</script>
<template>
  <div />
</template>
