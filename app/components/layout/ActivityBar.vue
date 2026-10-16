<script setup lang="ts">
/** Thin indeterminate progress line: "something is catching up", without words. */
defineProps<{ label: string }>()
</script>

<template>
  <div class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" role="progressbar" :aria-label="label" aria-busy="true">
    <div class="activity-bar h-full w-1/3 rounded-full bg-primary/70" />
  </div>
</template>

<style scoped>
.activity-bar {
  animation: activity-slide 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes activity-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}

@media (prefers-reduced-motion: reduce) {
  .activity-bar {
    width: 100%;
    animation: none;
    opacity: 0.5;
  }
}
</style>
