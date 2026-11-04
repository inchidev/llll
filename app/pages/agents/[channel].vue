<script setup lang="ts">
definePageMeta({ layout: 'server', middleware: ['auth', 'agents'] })
</script>

<template>
  <ChatConversationView />
</template>
