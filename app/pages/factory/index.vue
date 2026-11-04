<script setup lang="ts">
// Factory's pages live under `/projects`. Keep these links working.
definePageMeta({ middleware: [() => navigateTo('/projects', { replace: true })] })
</script>
<template>
  <div />
</template>
