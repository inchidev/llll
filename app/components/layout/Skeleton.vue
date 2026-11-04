<script setup lang="ts">
/**
 * Content-shaped loading placeholder. It fades in after a short delay so fast
 * responses never flash a skeleton, and it mirrors the layout that replaces it
 * so nothing jumps when data arrives.
 */
const props = withDefaults(defineProps<{
  variant?: 'rows' | 'nav' | 'messages' | 'board' | 'table' | 'document' | 'form' | 'cards'
  rows?: number
}>(), {
  variant: 'rows',
  rows: undefined,
})

// Deterministic widths keep SSR and client markup identical.
const widths = ['w-3/5', 'w-2/5', 'w-4/5', 'w-1/2', 'w-3/4', 'w-1/3', 'w-2/3']
const count = computed(() => props.rows ?? ({
  rows: 4, nav: 5, messages: 6, board: 3, table: 6, document: 6, form: 4, cards: 3,
} as const)[props.variant])
const width = (index: number) => widths[index % widths.length]
</script>

<template>
  <div class="df-skeleton" aria-busy="true" aria-live="polite">
    <span class="sr-only">Loading</span>

    <div v-if="variant === 'nav'" class="space-y-1 px-2 py-1">
      <div v-for="index in count" :key="index" class="flex h-8 items-center gap-2 px-2">
        <USkeleton class="size-4 shrink-0 rounded" />
        <USkeleton class="h-3" :class="width(index)" />
      </div>
    </div>

    <div v-else-if="variant === 'rows'" class="space-y-1 p-2">
      <div v-for="index in count" :key="index" class="flex h-10 items-center gap-3 px-2">
        <USkeleton class="size-7 shrink-0 rounded-full" />
        <USkeleton class="h-3" :class="width(index)" />
      </div>
    </div>

    <div v-else-if="variant === 'messages'" class="flex h-full flex-col justify-end gap-5 px-4 pb-4">
      <div v-for="index in count" :key="index" class="flex gap-3">
        <USkeleton class="size-9 shrink-0 rounded-full" />
        <div class="min-w-0 flex-1 space-y-2 pt-1">
          <div class="flex items-center gap-2">
            <USkeleton class="h-3 w-24" />
            <USkeleton class="h-2.5 w-12 opacity-60" />
          </div>
          <USkeleton class="h-3" :class="width(index)" />
          <USkeleton v-if="index % 3 === 0" class="h-3" :class="width(index + 2)" />
        </div>
      </div>
    </div>

    <div v-else-if="variant === 'board'" class="flex gap-4 overflow-hidden p-4">
      <div v-for="column in count" :key="column" class="w-72 shrink-0 space-y-2">
        <USkeleton class="mb-3 h-3.5 w-24" />
        <div v-for="card in 4 - (column % 2)" :key="card" class="space-y-2 rounded-lg border border-default p-3">
          <USkeleton class="h-3" :class="width(column + card)" />
          <USkeleton class="h-2.5 w-1/4 opacity-60" />
        </div>
      </div>
    </div>

    <div v-else-if="variant === 'table'" class="p-4">
      <div class="overflow-hidden rounded-lg border border-default">
        <div class="flex gap-4 border-b border-default bg-elevated/40 px-3 py-2.5">
          <USkeleton v-for="column in 4" :key="column" class="h-3 flex-1" />
        </div>
        <div v-for="row in count" :key="row" class="flex gap-4 border-b border-default px-3 py-3 last:border-b-0">
          <USkeleton v-for="column in 4" :key="column" class="h-3 flex-1" :class="(row + column) % 3 === 0 ? 'opacity-60' : ''" />
        </div>
      </div>
    </div>

    <div v-else-if="variant === 'document'" class="mx-auto max-w-3xl space-y-3 px-6 py-8">
      <USkeleton class="mb-6 h-7 w-1/2" />
      <USkeleton v-for="index in count" :key="index" class="h-3" :class="index % 4 === 0 ? 'w-2/5' : 'w-full'" />
    </div>

    <div v-else-if="variant === 'form'" class="space-y-6">
      <div v-for="index in count" :key="index" class="space-y-2">
        <USkeleton class="h-3 w-28" />
        <USkeleton class="h-9 w-full" />
      </div>
    </div>

    <div v-else-if="variant === 'cards'" class="space-y-3">
      <div v-for="index in count" :key="index" class="flex items-center gap-3 rounded-lg border border-default p-4">
        <USkeleton class="size-9 shrink-0 rounded-md" />
        <div class="min-w-0 flex-1 space-y-2">
          <USkeleton class="h-3" :class="width(index)" />
          <USkeleton class="h-2.5 w-1/4 opacity-60" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.df-skeleton {
  animation: df-skeleton-in 200ms ease-out 180ms both;
}

@keyframes df-skeleton-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .df-skeleton {
    animation-duration: 1ms;
  }
}
</style>
