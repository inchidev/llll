<script setup lang="ts">
/** A page or panel with nothing in it yet: what this place is for, and the first step. */
defineProps<{
  icon: string
  title: string
  description?: string
}>()
</script>

<template>
  <div class="grid flex-1 place-items-center px-6 py-16">
    <div class="max-w-sm text-center">
      <span class="mx-auto flex size-11 items-center justify-center rounded-full bg-elevated text-muted">
        <UIcon :name="icon" class="size-5" />
      </span>
      <p class="mt-4 font-medium text-highlighted">{{ title }}</p>
      <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
      <div v-if="$slots.default" class="mt-5 flex justify-center gap-2">
        <slot />
      </div>
    </div>
  </div>
</template>
