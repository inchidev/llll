<script setup lang="ts">
/** Title row for a settings pane; `back` turns it into a detail view header. */
const props = defineProps<{
  title: string
  description?: string
  back?: string
}>()
const emit = defineEmits<{ back: [] }>()

// Inside the settings overlay, its mobile header takes over this back button.
const overlayBack = inject(settingsDetailBackKey, null)
let ownBack: { label: string; go: () => void } | null = null
watchEffect(() => {
  if (overlayBack && props.back) {
    ownBack = { label: props.back, go: () => emit('back') }
    overlayBack.value = ownBack
  }
})
onBeforeUnmount(() => {
  if (overlayBack && overlayBack.value === ownBack) overlayBack.value = null
})
</script>

<template>
  <div class="relative">
    <button
      v-if="back"
      type="button"
      class="absolute bottom-full mb-2 items-center gap-1 whitespace-nowrap rounded text-sm text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
      :class="overlayBack ? 'hidden md:inline-flex' : 'inline-flex'"
      @click="emit('back')"
    >
      <UIcon name="i-ph-caret-left" class="size-4" />
      {{ back }}
    </button>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <!-- As tall as an action button, so panes with and without actions line up. -->
        <div class="flex min-h-8 min-w-0 items-center gap-2">
          <h1 class="truncate text-xl font-semibold text-highlighted">{{ title }}</h1>
          <slot name="badge" />
        </div>
        <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex min-h-8 shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
