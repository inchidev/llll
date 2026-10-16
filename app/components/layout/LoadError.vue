<script setup lang="ts">
/**
 * A failed fetch, stated calmly with a way to try again. Reserve error-colored
 * alerts for things the person must act on; a list that did not load is not one.
 */
const props = withDefaults(defineProps<{
  message: string
  retry?: () => unknown
  /** Single line for navigation lists and other tight spaces. */
  inline?: boolean
}>(), {
  retry: undefined,
  inline: false,
})

const retrying = ref(false)
async function onRetry() {
  if (!props.retry) return
  retrying.value = true
  try {
    await props.retry()
  }
  finally {
    retrying.value = false
  }
}
</script>

<template>
  <div
    v-if="inline"
    class="flex items-center gap-2 px-2 py-1.5 text-sm text-muted"
    role="alert"
  >
    <UIcon name="i-ph-warning-circle" class="size-4 shrink-0 text-dimmed" />
    <span class="min-w-0 flex-1 truncate">{{ message }}</span>
    <UButton
      v-if="retry"
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-ph-arrow-clockwise"
      aria-label="Try again"
      :loading="retrying"
      @click="onRetry"
    />
  </div>
  <div v-else class="flex flex-col items-center gap-3 px-4 py-10 text-center" role="alert">
    <span class="flex size-9 items-center justify-center rounded-full bg-elevated text-muted">
      <UIcon name="i-ph-cloud-slash" class="size-5" />
    </span>
    <p class="text-sm text-muted">{{ message }}</p>
    <UButton
      v-if="retry"
      size="sm"
      color="neutral"
      variant="soft"
      icon="i-ph-arrow-clockwise"
      label="Try again"
      :loading="retrying"
      @click="onRetry"
    />
  </div>
</template>
