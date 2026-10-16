<script setup lang="ts">
import type { ProgressState } from '../composables/useAdmin'

defineProps<{
  steps: ReadonlyArray<{ id: string, label: string }>
  state: Record<string, ProgressState>
}>()

function icon(value: ProgressState | undefined) {
  if (value === 'complete') return 'i-ph-check-circle-fill'
  if (value === 'active') return 'i-ph-spinner-gap'
  return 'i-ph-circle'
}
</script>

<template>
  <ol class="space-y-2.5">
    <li v-for="step in steps" :key="step.id" class="flex items-center gap-3 text-sm" :class="state[step.id] ? 'text-highlighted' : 'text-dimmed'">
      <UIcon
        :name="icon(state[step.id])"
        class="size-4 shrink-0"
        :class="{ 'animate-spin text-primary': state[step.id] === 'active', 'text-primary': state[step.id] === 'complete' }"
      />
      {{ step.label }}
    </li>
  </ol>
</template>
