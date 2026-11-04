<script setup lang="ts">
// Matches spa-loading-template.html and the Shell overlay pixel for pixel. The negative
// delay keeps the pulse on the page clock, so swapping screens does not restart it.
const delay = import.meta.client ? `-${Math.round(performance.now() % 2000)}ms` : '0ms'
</script>

<template>
  <div role="status" aria-label="Opening L4" class="fixed inset-0 flex items-center justify-center bg-black text-white">
    <svg viewBox="0 0 32 32" width="48" height="48" fill="currentColor" aria-hidden="true" class="animate-pulse" :style="{ animationDelay: delay }">
      <path d="M2 2h4v8h8v4H2V2Zm16 0h4v8h8v4H18V2ZM2 18h4v8h8v4H2V18Zm16 0h4v8h8v4H18V18Z" />
    </svg>
  </div>
</template>
