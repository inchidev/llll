<script setup lang="ts">
/** Sticky "unsaved changes" bar, so edits deep in a long pane are never lost or hidden. */
defineProps<{
  dirty: boolean
  saving?: boolean
  disabled?: boolean
}>()
defineEmits<{ save: [], reset: [] }>()
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="translate-y-3 opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="translate-y-3 opacity-0"
  >
    <div
      v-if="dirty"
      class="sticky bottom-4 z-10 mt-6 flex items-center gap-3 rounded-lg border border-default bg-elevated px-4 py-2.5 shadow-lg"
      role="status"
    >
      <p class="min-w-0 flex-1 truncate text-sm text-default">You have unsaved changes</p>
      <UButton color="neutral" variant="ghost" size="sm" label="Reset" :disabled="saving" @click="$emit('reset')" />
      <UButton size="sm" label="Save changes" :loading="saving" :disabled="disabled" @click="$emit('save')" />
    </div>
  </Transition>
</template>
