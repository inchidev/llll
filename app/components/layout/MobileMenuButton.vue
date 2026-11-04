<script setup lang="ts">
const ui = useUiStore()
</script>

<template>
  <!-- CSS decides visibility so the button is there from the first paint on phones. -->
  <UButton
    icon="i-ph-list"
    color="neutral"
    variant="ghost"
    size="md"
    square
    class="-ms-1.5 size-10 shrink-0 justify-center md:hidden"
    aria-label="Open navigation"
    aria-controls="channel-navigation"
    :aria-expanded="ui.mobilePane === 'channels'"
    @click="ui.mobilePane = 'channels'"
  />
</template>
