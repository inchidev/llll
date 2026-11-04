<script setup lang="ts">
// Boards live under Projects. Earlier links, with their ?board=, ?task= and ?project=, keep working.
definePageMeta({ middleware: [to => navigateTo({ path: '/projects/board', query: to.query, hash: to.hash }, { replace: true })] })
</script>
<template>
  <div />
</template>
