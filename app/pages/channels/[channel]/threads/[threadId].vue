<script setup lang="ts">
// Route only. `[channel].vue` is this route's parent and renders the whole
// conversation; ConversationView reads `threadId` from the router's live route
// and opens the thread panel. Nothing here is rendered.
definePageMeta({ middleware: ['auth'] })
</script>

<template>
  <div />
</template>
